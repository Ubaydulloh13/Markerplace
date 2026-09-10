import http from 'node:http'
import {readFile, writeFile, mkdir, rename} from 'node:fs/promises'
import {dirname, join, resolve} from 'node:path'
import {fileURLToPath} from 'node:url'
import {randomBytes, randomUUID, createHash, createHmac, scryptSync, timingSafeEqual} from 'node:crypto'

const root = dirname(fileURLToPath(import.meta.url))
const isVercel = process.env.VERCEL === '1'
const dbPath = process.env.BOZOR_DB_PATH ? resolve(process.env.BOZOR_DB_PATH) : isVercel ? '/tmp/bozorly-db.json' : join(root, 'data', 'db.json')
const seedDbPath = join(root, 'data', 'db.json')
const port = Number(process.env.PORT ?? 3001)
const sessionName = 'bozor-session'
const sessionLifetime = 30 * 24 * 60 * 60 * 1000
const sessionSecret = process.env.SESSION_SECRET || 'bozorly-development-session-secret'
const admin = {id: 'admin', name: 'Ubaydulloh', email: 'admin@bozorly.uz', phone: '+998 90 000 20 13', role: 'admin', createdAt: null}
const empty = () => ({users: [], products: [], orders: [], sellerApplications: [], reviews: [], messages: [], wallets: {}, withdrawals: [], loginEvents: [], sessions: [], conversations: [], chatMessages: [], adminPassword: null})
const sameId = (left, right) => left != null && right != null && String(left) === String(right)
const normalized = value => typeof value === 'string' ? value.trim().toLocaleLowerCase() : ''
const now = () => new Date().toISOString()
const allUsers = data => [admin, ...data.users.filter(user => !sameId(user.id, admin.id))]
const findUser = (data, id) => allUsers(data).find(user => sameId(user.id, id))
const isSeller = user => user && ['admin', 'seller'].includes(user.role)

class ApiError extends Error {
  constructor(status, message) { super(message); this.status = status }
}
const fail = (status, message) => { throw new ApiError(status, message) }
const requiredText = (value, label, max = 200) => {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max) fail(400, `${label}: to‘g‘ri ma’lumot kiriting (1–${max} belgi).`)
  return value.trim()
}
const optionalText = (value, max = 200) => typeof value === 'string' ? value.trim().slice(0, max) : ''

async function readDatabase() {
  try {
    const data = {...empty(), ...JSON.parse(await readFile(dbPath, 'utf8'))}
    for (const key of ['users', 'products', 'orders', 'sellerApplications', 'reviews', 'messages', 'withdrawals', 'loginEvents', 'sessions', 'conversations', 'chatMessages']) {
      if (!Array.isArray(data[key])) fail(500, `Baza maydoni yaroqsiz: ${key}`)
    }
    return data
  } catch (error) {
    if (error.code === 'ENOENT') {
      const seed = isVercel && dbPath !== seedDbPath ? await readFile(seedDbPath, 'utf8') : null
      return {...empty(), ...(seed ? JSON.parse(seed) : {})}
    }
    throw error
  }
}

// Requests commit one complete snapshot. The queue prevents concurrent sends
// overwriting each other; rename prevents partially written database files.
async function saveDatabase(data) {
  await mkdir(dirname(dbPath), {recursive: true})
  const temporary = `${dbPath}.${process.pid}.tmp`
  await writeFile(temporary, JSON.stringify(data, null, 2), {mode: 0o600})
  await rename(temporary, dbPath)
}
let databaseQueue = Promise.resolve()
function transaction(work) {
  const result = databaseQueue.then(async () => {
    const context = {data: await readDatabase(), changed: false}
    migratePlaintextPasswords(context)
    migrateLegacyMessages(context)
    const response = await work(context)
    if (context.changed) await saveDatabase(context.data)
    return response
  })
  databaseQueue = result.catch(() => {})
  return result
}

function safeUser(user, data) {
  const events = data.loginEvents.filter(event => sameId(event.userId, user.id))
  const dates = events.map(event => event.at).filter(Boolean).sort()
  return {id: user.id, name: user.name, email: user.email, login: user.role === 'admin' ? 'Ubaydulloh' : user.email,
    phone: user.phone || '', role: user.role, createdAt: user.createdAt || null,
    loginCount: events.length, lastLoginAt: dates.at(-1) || null}
}
const isHashedPassword = value => typeof value === 'string' && /^[a-f0-9]{32}:[a-f0-9]{128}$/i.test(value)
function migratePlaintextPasswords(context) {
  let migrated = false
  for (const user of context.data.users) {
    if (typeof user.password === 'string' && user.password && !isHashedPassword(user.password)) {
      user.password = hashPassword(user.password)
      migrated = true
    }
  }
  if (migrated) context.changed = true
}
function hashPassword(password) {
  const salt = randomBytes(16).toString('hex')
  return `${salt}:${scryptSync(password, salt, 64).toString('hex')}`
}
function checkPassword(password, stored) {
  if (typeof password !== 'string' || typeof stored !== 'string') return false
  try {
    if (/^[a-f0-9]{32}:[a-f0-9]{128}$/i.test(stored)) {
      const [salt, hash] = stored.split(':')
      return timingSafeEqual(Buffer.from(hash, 'hex'), scryptSync(password, salt, 64))
    }
    const entered = Buffer.from(password), legacy = Buffer.from(stored)
    return entered.length === legacy.length && timingSafeEqual(entered, legacy)
  } catch { return false }
}
const tokenHash = token => createHash('sha256').update(token).digest('hex')
function cookieToken(req) {
  return req.headers.cookie?.split(';').map(part => part.trim()).find(part => part.startsWith(`${sessionName}=`))?.slice(sessionName.length + 1) || ''
}
function statelessSession(user) {
  const payload = Buffer.from(JSON.stringify({id: user.id, name: user.name, email: user.email, phone: user.phone || '', role: user.role, exp: Date.now() + sessionLifetime})).toString('base64url')
  const signature = createHmac('sha256', sessionSecret).update(payload).digest('base64url')
  return `${payload}.${signature}`
}
function statelessUser(token) {
  try {
    const [payload, signature] = token.split('.')
    if (!payload || !signature) return null
    const expected = createHmac('sha256', sessionSecret).update(payload).digest('base64url')
    if (signature.length !== expected.length || !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null
    const user = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
    return user.exp > Date.now() && user.id && user.role ? user : null
  } catch { return null }
}
function sessionUser(req, data) {
  const token = cookieToken(req)
  if (!token) return null
  if (isVercel) return statelessUser(token)
  const session = data.sessions.find(item => item.tokenHash === tokenHash(token) && Date.parse(item.expiresAt) > Date.now())
  return session ? findUser(data, session.userId) : null
}
function requireUser(req, data, role) {
  const user = sessionUser(req, data)
  if (!user) fail(401, 'Davom etish uchun hisobingizga qayta kiring.')
  if (role && user.role !== role) fail(403, 'Bu bo‘lim faqat katta admin uchun.')
  return user
}
function sessionCookie(token, expires = sessionLifetime) {
  return `${sessionName}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(expires / 1000)}${process.env.NODE_ENV === 'production' ? '; Secure' : ''}`
}
function signIn(context, req, user, login, type) {
  const token = isVercel ? statelessSession(user) : randomBytes(32).toString('hex'), at = now(), oldHash = cookieToken(req) ? tokenHash(cookieToken(req)) : null
  context.data.sessions = context.data.sessions.filter(session => Date.parse(session.expiresAt) > Date.now() && session.tokenHash !== oldHash)
  context.data.sessions.push({tokenHash: tokenHash(token), userId: user.id, createdAt: at, expiresAt: new Date(Date.now() + sessionLifetime).toISOString()})
  context.data.loginEvents.push({id: randomUUID(), userId: user.id, name: user.name, login, role: user.role, type, at})
  context.changed = true
  return {'Set-Cookie': sessionCookie(token)}
}

function approvedShops(data) {
  return data.sellerApplications.filter(app => app.status === 'approved' && isSeller(findUser(data, app.userId))).map(app => ({
    id: app.id, sellerId: findUser(data, app.userId).id, sellerName: findUser(data, app.userId).name,
    name: app.shop, shop: app.shop,
  }))
}
function resolveSeller(data, sellerId, sellerName) {
  if (sellerId != null && String(sellerId)) {
    const seller = findUser(data, sellerId)
    if (!isSeller(seller)) fail(404, 'Bu sotuvchi hali ro‘yxatdan o‘tmagan yoki tasdiqlanmagan.')
    return seller
  }
  const name = normalized(sellerName)
  if (!name) fail(400, 'Sotuvchini tanlang.')
  const matches = allUsers(data).filter(user => isSeller(user) && (
    normalized(user.name) === name || (user.role === 'admin' && ['ubaydullo', 'ubaydulloh'].includes(name)) ||
    data.sellerApplications.some(app => sameId(app.userId, user.id) && app.status === 'approved' && normalized(app.shop) === name)
  ))
  if (matches.length > 1) fail(409, 'Bu nom bilan bir nechta sotuvchi bor. Xabarlar bo‘limidan aniq do‘konni tanlang.')
  if (!matches.length) fail(404, 'Bu namunaviy do‘konning faol sotuvchi hisobi yo‘q. Xabarlar bo‘limidan ro‘yxatdan o‘tgan do‘konni tanlang.')
  return matches[0]
}
function getConversation(context, buyer, seller, product = {}) {
  let conversation = context.data.conversations.find(item => sameId(item.buyerId, buyer.id) && sameId(item.sellerId, seller.id))
  if (!conversation) {
    conversation = {id: randomUUID(), buyerId: buyer.id, sellerId: seller.id,
      productId: product.productId ?? null, productName: optionalText(product.productName), createdAt: now()}
    context.data.conversations.push(conversation)
    context.changed = true
  }
  return conversation
}
function participantConversation(data, id, user) {
  const conversation = data.conversations.find(item => sameId(item.id, id))
  if (!conversation || (!sameId(user.id, conversation.buyerId) && !sameId(user.id, conversation.sellerId))) fail(404, 'Suhbat topilmadi.')
  return conversation
}
function publicMessage(message) {
  return {id: message.id, conversationId: message.conversationId, senderId: message.senderId,
    senderName: message.senderName, text: message.text, createdAt: message.createdAt, readAt: message.readAt || null}
}
const conversationMessages = (data, id) => data.chatMessages.filter(message => sameId(message.conversationId, id))
  .sort((left, right) => String(left.createdAt || '').localeCompare(String(right.createdAt || '')))
function conversationSummary(data, conversation, user) {
  const buyer = findUser(data, conversation.buyerId), seller = findUser(data, conversation.sellerId)
  const shop = data.sellerApplications.find(app => sameId(app.userId, conversation.sellerId) && app.status === 'approved')
  const messages = conversationMessages(data, conversation.id), last = messages.at(-1)
  return {id: conversation.id, buyerId: conversation.buyerId, sellerId: conversation.sellerId,
    buyerName: buyer?.name || 'Xaridor', sellerName: seller?.name || 'Sotuvchi', shopName: shop?.shop || seller?.name || 'Do‘kon',
    productName: conversation.productName || '', lastMessage: last ? publicMessage(last) : null,
    updatedAt: last?.createdAt || conversation.createdAt,
    unreadCount: messages.filter(message => !sameId(message.senderId, user.id) && !message.readAt).length}
}
function migrateLegacyMessages(context) {
  const {data} = context
  for (const legacy of data.messages) {
    if (!legacy.id || data.chatMessages.some(message => sameId(message.legacyId, legacy.id))) continue
    const buyer = findUser(data, legacy.userId)
    if (!buyer || typeof legacy.text !== 'string' || !legacy.text.trim()) continue
    let seller
    try { seller = resolveSeller(data, legacy.sellerId, legacy.seller) } catch { continue }
    if (sameId(buyer.id, seller.id)) continue
    let sender
    if (legacy.senderId != null) sender = [buyer, seller].find(user => sameId(user.id, legacy.senderId))
    else {
      const matches = [buyer, seller].filter(user => normalized(user.name) === normalized(legacy.from))
      if (matches.length === 1) sender = matches[0]
    }
    // Ambiguous old display names remain untouched in the legacy archive.
    if (!sender) continue
    const conversation = getConversation(context, buyer, seller, legacy)
    data.chatMessages.push({id: randomUUID(), legacyId: legacy.id, conversationId: conversation.id,
      senderId: sender.id, senderName: sender.name, text: legacy.text, createdAt: legacy.createdAt || null, readAt: null})
    context.changed = true
  }
}

function accountOverview(data) {
  const users = allUsers(data).map(user => ({...safeUser(user, data), isSystemAccount: user.role === 'admin',
    shops: data.sellerApplications.filter(app => sameId(app.userId, user.id)).map(app => ({
      id: app.id, shop: app.shop, status: app.status, products: app.products, phone: app.phone, createdAt: app.createdAt || null,
    })),
  }))
  const events = data.loginEvents.map(event => ({id: event.id, userId: event.userId, name: event.name,
    login: event.login, role: event.role, type: event.type || 'login', at: event.at || null}))
    .sort((left, right) => String(right.at || '').localeCompare(String(left.at || '')))
  return {users, events, stats: {registeredUsers: users.filter(user => !user.isSystemAccount).length, totalAccounts: users.length,
    totalLogins: events.length, uniqueSignedInUsers: new Set(events.map(event => String(event.userId))).size,
    sellerCount: users.filter(user => user.role === 'seller').length}}
}

function route(req, url, payload, context) {
  const {data} = context, path = url.pathname, method = req.method
  const result = (value, status = 200, headers = {}) => ({status, data: value, headers})
  if (method === 'GET' && path === '/api/health') return result({ok: true, service: 'Bozorly API'})
  if (method === 'POST' && path === '/api/register') {
    const name = requiredText(payload.name, 'Ism', 100), email = requiredText(payload.email, 'Email yoki login', 254),
      phone = requiredText(payload.phone, 'Telefon', 40), password = payload.password
    if (typeof password !== 'string' || password.length < 4 || password.length > 200) fail(400, 'Parol 4–200 ta belgidan iborat bo‘lsin.')
    if (/\s/.test(email)) fail(400, 'Email yoki loginda bo‘sh joy bo‘lmasin.')
    if (phone.replace(/\D/g, '').length < 7 || phone.replace(/\D/g, '').length > 15) fail(400, 'Telefon raqamini to‘g‘ri kiriting.')
    if (['ubaydullo', 'ubaydulloh', normalized(admin.email)].includes(normalized(email)) || data.users.some(user => normalized(user.email) === normalized(email))) fail(409, 'Bu email yoki login band. Boshqasini tanlang.')
    const user = {id: randomUUID(), name, email, phone, password: hashPassword(password), role: 'buyer', createdAt: now()}
    data.users.push(user)
    const headers = signIn(context, req, user, email, 'register')
    return result(safeUser(user, data), 201, headers)
  }
  if (method === 'POST' && path === '/api/login') {
    const login = requiredText(payload.login, 'Login', 254), password = payload.password
    if (typeof password !== 'string' || !password || password.length > 200) fail(401, 'Login yoki parol noto‘g‘ri.')
    let user
    if (['ubaydulloh', 'ubaydullo', normalized(admin.email)].includes(normalized(login))) {
      if (checkPassword(password, data.adminPassword) || (!data.adminPassword && password === '2013')) user = admin
    } else {
      const emailMatches = data.users.filter(item => normalized(item.email) === normalized(login))
      const candidates = (emailMatches.length ? emailMatches : data.users.filter(item => normalized(item.name) === normalized(login)))
        .filter(item => checkPassword(password, item.password))
      if (candidates.length > 1) fail(409, 'Bu ism bilan bir nechta hisob bor. O‘z emailingiz bilan kiring.')
      user = candidates[0]
    }
    if (!user) fail(401, 'Login yoki parol noto‘g‘ri.')
    if (user !== admin && !/^[a-f0-9]{32}:[a-f0-9]{128}$/i.test(user.password)) user.password = hashPassword(password)
    const headers = signIn(context, req, user, login, 'login')
    return result(safeUser(user, data), 200, headers)
  }
  if (method === 'POST' && path === '/api/logout') {
    const token = cookieToken(req)
    if (token) { data.sessions = data.sessions.filter(session => session.tokenHash !== tokenHash(token)); context.changed = true }
    return result({ok: true}, 200, {'Set-Cookie': sessionCookie('', 0)})
  }
  const user = requireUser(req, data)
  if (method === 'POST' && path === '/api/account/password') {
    const currentPassword = payload.currentPassword, newPassword = payload.newPassword
    const currentMatches = user.role === 'admin'
      ? (checkPassword(currentPassword, data.adminPassword) || (!data.adminPassword && currentPassword === '2013'))
      : checkPassword(currentPassword, user.password)
    if (!currentMatches) fail(401, 'Amaldagi parol noto‘g‘ri.')
    if (typeof newPassword !== 'string' || newPassword.length < 4 || newPassword.length > 200) fail(400, 'Yangi parol 4–200 ta belgidan iborat bo‘lsin.')
    if (newPassword === currentPassword) fail(400, 'Yangi parol eski paroldan farq qilsin.')
    if (user.role === 'admin') data.adminPassword = hashPassword(newPassword)
    else user.password = hashPassword(newPassword)
    context.changed = true
    return result({ok: true})
  }
  if (method === 'GET' && path === '/api/me') return result(safeUser(user, data))
  if (method === 'GET' && path === '/api/admin/accounts') {
    requireUser(req, data, 'admin')
    return result(accountOverview(data))
  }
  if (method === 'GET' && path === '/api/users') {
    requireUser(req, data, 'admin')
    return result(allUsers(data).map(item => safeUser(item, data)))
  }
  if (method === 'GET' && path.startsWith('/api/users/')) {
    const id = decodeURIComponent(path.split('/').pop())
    if (user.role !== 'admin' && !sameId(user.id, id)) fail(403, 'Bu hisobni ko‘rishga ruxsat yo‘q.')
    const found = findUser(data, id)
    if (!found) fail(404, 'Foydalanuvchi topilmadi.')
    return result(safeUser(found, data))
  }
  if (method === 'GET' && path === '/api/login-events') {
    requireUser(req, data, 'admin')
    return result(accountOverview(data).events)
  }
  if (method === 'GET' && path === '/api/shops') return result([
    {id: 'admin', sellerId: admin.id, sellerName: admin.name, name: 'Ubaydulloh', shop: 'Ubaydulloh'}, ...approvedShops(data),
  ])
  if (method === 'GET' && path === '/api/products') return result(data.products)
  if (method === 'POST' && path === '/api/products') {
    if (!isSeller(user)) fail(403, 'Mahsulot qo‘shish uchun sotuvchi hisob kerak.')
    const name = requiredText(payload.name, 'Mahsulot nomi', 200)
    const price = Number(payload.price)
    if (!Number.isSafeInteger(price) || price <= 0) fail(400, 'Mahsulot narxini to‘g‘ri kiriting.')
    const clientId = optionalText(payload.clientId, 100)
    const existing = clientId && data.products.find(item => sameId(item.sellerId, user.id) && item.clientId === clientId)
    if (existing) return result(existing)
    const product = {
      id: randomUUID(), name, category: optionalText(payload.category, 100) || 'Boshqa', price,
      old: 0, rating: '5.0', reviews: 0, stock: Number.isSafeInteger(Number(payload.stock)) && Number(payload.stock) > 0 ? Number(payload.stock) : 1,
      seller: user.name, sellerId: user.id, image: optionalText(payload.image, 3500000), fallback: optionalText(payload.fallback, 300), custom: true, createdAt: now(), ...(clientId ? {clientId} : {}),
    }
    data.products.unshift(product)
    context.changed = true
    return result(product, 201)
  }
  if (method === 'DELETE' && path.startsWith('/api/products/')) {
    const product = data.products.find(item => sameId(item.id, decodeURIComponent(path.split('/').pop())))
    if (!product) fail(404, 'Mahsulot topilmadi.')
    if (user.role !== 'admin' && !sameId(product.sellerId, user.id)) fail(403, 'Bu mahsulotni o‘chirishga ruxsat yo‘q.')
    data.products = data.products.filter(item => item !== product)
    context.changed = true
    return result({ok: true})
  }
  if (path === '/api/messages') fail(410, 'Chat yangilandi. Xabarlar bo‘limidan suhbatni oching.')
  if (method === 'GET' && path === '/api/conversations') return result(data.conversations
    .filter(conversation => sameId(conversation.buyerId, user.id) || sameId(conversation.sellerId, user.id))
    .map(conversation => conversationSummary(data, conversation, user))
    .sort((left, right) => String(right.updatedAt || '').localeCompare(String(left.updatedAt || ''))))
  if (method === 'POST' && path === '/api/conversations') {
    const seller = resolveSeller(data, payload.sellerId, payload.seller)
    if (sameId(seller.id, user.id)) fail(400, 'O‘zingizga xabar yubora olmaysiz. Xaridor yozgan suhbatni Xabarlar bo‘limidan oching.')
    return result(conversationSummary(data, getConversation(context, user, seller, payload), user), 201)
  }
  const conversationRoute = path.match(/^\/api\/conversations\/([^/]+)\/(messages|read)$/)
  if (conversationRoute) {
    const conversation = participantConversation(data, decodeURIComponent(conversationRoute[1]), user)
    if (method === 'GET' && conversationRoute[2] === 'messages') return result(conversationMessages(data, conversation.id).map(publicMessage))
    if (method === 'POST' && conversationRoute[2] === 'messages') {
      const text = requiredText(payload.text, 'Xabar', 4000)
      const clientId = payload.clientId == null ? '' : requiredText(payload.clientId, 'Xabar identifikatori', 100)
      if (clientId) {
        const existing = data.chatMessages.find(message => sameId(message.conversationId, conversation.id) && sameId(message.senderId, user.id) && message.clientId === clientId)
        if (existing) return result(publicMessage(existing))
      }
      const message = {id: randomUUID(), conversationId: conversation.id, senderId: user.id, senderName: user.name, text,
        createdAt: now(), readAt: null, ...(clientId ? {clientId} : {})}
      data.chatMessages.push(message)
      context.changed = true
      return result(publicMessage(message), 201)
    }
    if (method === 'PATCH' && conversationRoute[2] === 'read') {
      const readAt = now()
      for (const message of data.chatMessages) if (sameId(message.conversationId, conversation.id) && !sameId(message.senderId, user.id) && !message.readAt) {
        message.readAt = readAt
        context.changed = true
      }
      return result({ok: true, unreadCount: 0})
    }
  }
  if (method === 'POST' && path === '/api/seller-applications') {
    if (isSeller(user)) fail(409, 'Sotuvchi kabinetingiz allaqachon tayyor.')
    const shop = requiredText(payload.shop, 'Do‘kon nomi', 100), phone = requiredText(payload.phone, 'Telefon', 40), products = requiredText(payload.products, 'Mahsulotlar', 1000)
    if (data.sellerApplications.some(app => sameId(app.userId, user.id) && app.status === 'pending')) fail(409, 'Arizangiz tekshirilmoqda.')
    const application = {id: randomUUID(), userId: user.id, name: user.name, email: user.email, shop, phone, products, status: 'pending', createdAt: now()}
    data.sellerApplications.push(application)
    context.changed = true
    return result(application, 201)
  }
  if (method === 'GET' && path === '/api/seller-applications') return result(data.sellerApplications.filter(app => user.role === 'admin' || sameId(app.userId, user.id)))
  if (method === 'PATCH' && path.startsWith('/api/seller-applications/')) {
    requireUser(req, data, 'admin')
    const application = data.sellerApplications.find(app => sameId(app.id, decodeURIComponent(path.split('/').pop())))
    if (!application) fail(404, 'Ariza topilmadi.')
    if (!['approved', 'rejected'].includes(payload.status)) fail(400, 'Ariza holati noto‘g‘ri.')
    const owner = data.users.find(item => sameId(item.id, application.userId))
    if (!owner) fail(404, 'Ariza egasi topilmadi.')
    application.status = payload.status
    application.reviewedAt = now()
    application.reviewedBy = user.id
    owner.role = data.sellerApplications.some(app => sameId(app.userId, owner.id) && app.status === 'approved') ? 'seller' : 'buyer'
    context.changed = true
    return result(application)
  }
  if (method === 'GET' && path === '/api/reviews') return result(data.reviews.filter(review => !url.searchParams.get('productId') || sameId(review.productId, url.searchParams.get('productId'))))
  if (method === 'POST' && path === '/api/reviews') {
    if (payload.productId == null) fail(400, 'Mahsulotni tanlang.')
    const review = {id: randomUUID(), productId: payload.productId, userId: user.id, user: user.name,
      text: requiredText(payload.text, 'Izoh', 4000), rating: Math.min(5, Math.max(1, Number(payload.rating) || 5)), createdAt: now()}
    data.reviews.push(review)
    context.changed = true
    return result(review, 201)
  }
  if (method === 'POST' && path === '/api/orders') {
    const phone = requiredText(payload.phone, 'Telefon', 40), address = requiredText(payload.address, 'Manzil', 500)
    if (!Array.isArray(payload.items) || !payload.items.length || payload.items.length > 500) fail(400, 'Buyurtma mahsulotlarini tekshiring.')
    const items = payload.items.map(item => {
      if (!item || item.id == null || !Number.isSafeInteger(Number(item.price)) || Number(item.price) <= 0) fail(400, 'Mahsulot narxi noto‘g‘ri.')
      const sellerName = requiredText(item.seller, 'Sotuvchi', 100)
      let seller
      try { seller = resolveSeller(data, item.sellerId, sellerName) } catch (error) { if (error.status !== 404 || item.sellerId != null) throw error }
      return {id: item.id, name: requiredText(item.name, 'Mahsulot nomi', 200), price: Number(item.price), seller: sellerName, sellerId: seller?.id || null}
    })
    const total = items.reduce((sum, item) => sum + item.price, 0)
    if (!Number.isSafeInteger(total)) fail(400, 'Buyurtma summasi juda katta.')
    const order = {id: randomUUID(), userId: user.id, user: user.name, phone, address, payment: optionalText(payload.payment), total, items, status: 'Yangi', createdAt: now()}
    data.orders.push(order)
    for (const item of items) if (item.sellerId != null) {
      const key = walletKey(findUser(data, item.sellerId))
      data.wallets[key] = (Number(data.wallets[key]) || 0) + item.price
    }
    context.changed = true
    return result(order, 201)
  }
  if (method === 'GET' && path === '/api/orders') return result(data.orders.flatMap(order => {
    if (user.role === 'admin' || sameId(order.userId, user.id)) return [order]
    if (!isSeller(user)) return []
    const items = order.items.filter(item => {
      if (item.sellerId != null) return sameId(item.sellerId, user.id)
      try { return sameId(resolveSeller(data, null, item.seller).id, user.id) } catch { return false }
    })
    return items.length ? [{...order, items, total: items.reduce((sum, item) => sum + Number(item.price || 0), 0)}] : []
  }))
  if (method === 'GET' && path === '/api/wallet') {
    if (!isSeller(user)) fail(403, 'Bu bo‘lim sotuvchilar uchun.')
    migrateWallet(context, user)
    return result({seller: user.name, sellerId: user.id, balance: Number(data.wallets[walletKey(user)]) || 0,
      withdrawals: data.withdrawals.filter(item => item.sellerId != null ? sameId(item.sellerId, user.id) : legacySellerIsUser(data, item.seller, user))})
  }
  if (method === 'POST' && path === '/api/withdraw') {
    if (!isSeller(user)) fail(403, 'Bu bo‘lim sotuvchilar uchun.')
    migrateWallet(context, user)
    const key = walletKey(user), balance = Number(data.wallets[key]) || 0, amount = Number(payload.amount)
    if (!Number.isSafeInteger(amount) || amount <= 0 || amount > balance) fail(400, 'Mablag‘ yetarli emas yoki summa noto‘g‘ri.')
    data.wallets[key] = balance - amount
    const withdrawal = {id: randomUUID(), seller: user.name, sellerId: user.id, amount, status: 'Demo yechildi', createdAt: now()}
    data.withdrawals.push(withdrawal)
    context.changed = true
    return result({...withdrawal, balance: data.wallets[key]}, 201)
  }
  fail(404, 'Endpoint topilmadi.')
}

const walletKey = user => `user:${user.id}`
function legacySellerIsUser(data, sellerName, user) {
  try { return sameId(resolveSeller(data, null, sellerName).id, user.id) } catch { return false }
}
function migrateWallet(context, user) {
  const {data} = context
  data.walletMigrations ||= {}
  if (data.walletMigrations[walletKey(user)]) return
  const aliases = [...new Set([user.name, ...data.sellerApplications.filter(app => sameId(app.userId, user.id) && app.status === 'approved').map(app => app.shop)])]
  let amount = 0
  for (const alias of aliases) if (Object.hasOwn(data.wallets, alias) && legacySellerIsUser(data, alias, user)) amount += Number(data.wallets[alias]) || 0
  data.wallets[walletKey(user)] = (Number(data.wallets[walletKey(user)]) || 0) + amount
  data.walletMigrations[walletKey(user)] = now()
  context.changed = true
}

function readBody(req) {
  return new Promise((resolveBody, reject) => {
    let raw = '', size = 0
    req.on('data', chunk => {
      size += chunk.length
      if (size > 6e6) { reject(new ApiError(413, 'So‘rov juda katta.')); return }
      raw += chunk
    })
    req.on('end', () => {
      try {
        const value = raw ? JSON.parse(raw) : {}
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error()
        resolveBody(value)
      } catch { reject(new ApiError(400, 'So‘rov JSON shaklida bo‘lsin.')) }
    })
    req.on('error', reject)
    req.on('aborted', () => reject(new ApiError(400, 'So‘rov uzildi.')))
  })
}
function send(res, response) {
  res.writeHead(response.status, {'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff', ...response.headers})
  res.end(JSON.stringify(response.data))
}
export const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'OPTIONS') return send(res, {status: 204, data: null})
    const url = new URL(req.url, 'http://localhost')
    if (['POST', 'PATCH', 'PUT', 'DELETE'].includes(req.method)) {
      if (req.headers['sec-fetch-site'] === 'cross-site') fail(403, 'Boshqa saytdan so‘rov qabul qilinmaydi.')
      if (req.headers.origin) {
        let sameHost = false
        try { sameHost = new URL(req.headers.origin).hostname === new URL(`http://${req.headers.host}`).hostname } catch {}
        if (!sameHost) fail(403, 'Boshqa saytdan so‘rov qabul qilinmaydi.')
      }
      if (req.headers['content-type'] && !req.headers['content-type'].toLowerCase().startsWith('application/json')) fail(415, 'Content-Type application/json bo‘lsin.')
    }
    const payload = ['POST', 'PATCH', 'PUT'].includes(req.method) ? await readBody(req) : {}
    send(res, await transaction(context => route(req, url, payload, context)))
  } catch (error) {
    if (!error.status) console.error('Bozorly API:', error)
    send(res, {status: error.status || 500, data: {error: error.status ? error.message : 'Serverda xatolik yuz berdi. Qayta urinib ko‘ring.'}})
  }
})
if (process.env.VERCEL !== '1') {
  server.listen(port, () => console.log(`Bozorly backend: http://localhost:${server.address().port}`))
}
