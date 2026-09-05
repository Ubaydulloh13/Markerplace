import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const password = 'Test-only-password-2048'

// Every test owns its server and temporary database. The application database and
// any server already running for development are deliberately never used.
async function fixture(t, initialData) {
  const directory = await mkdtemp(join(tmpdir(), 'bozor-chat-admin-'))
  const database = join(directory, 'db.json')
  if (initialData) await writeFile(database, JSON.stringify(initialData))
  let child
  let address

  async function stop() {
    if (!child || child.exitCode !== null) return
    const exited = once(child, 'exit')
    child.kill()
    await exited
    child = undefined
  }

  async function start() {
    child = spawn(process.execPath, [join(root, 'server.mjs')], {
      cwd: root,
      env: { ...process.env, PORT: '0', BOZOR_DB_PATH: database },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    let output = ''
    await new Promise((resolveReady, reject) => {
      const timeout = setTimeout(() => reject(new Error(`Server did not start: ${output}`)), 15_000)
      const finish = (error) => {
        clearTimeout(timeout)
        child.stdout.off('data', onOutput)
        child.off('error', finish)
        child.off('exit', onExit)
        if (error) reject(error)
        else resolveReady()
      }
      const onExit = (code) => finish(new Error(`Test server exited (${code}): ${output}`))
      const onOutput = (chunk) => {
        output += chunk.toString()
        const match = output.match(/http:\/\/localhost:(\d+)/)
        if (match && Number(match[1]) > 0) {
          address = `http://127.0.0.1:${match[1]}/api`
          finish()
        }
      }
      child.stdout.on('data', onOutput)
      child.stderr.on('data', (chunk) => { output += chunk.toString() })
      child.once('error', finish)
      child.once('exit', onExit)
    })
  }

  function client() {
    let cookie = ''
    return async (path, { method = 'GET', body, status = 200 } = {}) => {
      const response = await fetch(address + path, {
        method,
        headers: {
          ...(cookie ? { Cookie: cookie } : {}),
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })
      const setCookie = response.headers.get('set-cookie')
      if (setCookie) cookie = setCookie.split(';')[0]
      const text = await response.text()
      assert.equal(response.status, status, `${method} ${path}: ${text}`)
      return text ? JSON.parse(text) : null
    }
  }

  t.after(async () => {
    await stop()
    // directory is the exact unique path returned by mkdtemp above.
    assert.equal(dirname(directory), tmpdir())
    assert.ok(directory.startsWith(join(tmpdir(), 'bozor-chat-admin-')))
    await rm(directory, { recursive: true, force: true })
  })
  await start()
  return {
    client,
    restart: async () => { await stop(); await start() },
    saved: async () => JSON.parse(await readFile(database, 'utf8')),
  }
}

async function register(client, name, email) {
  return client('/register', {
    method: 'POST', status: 201,
    body: { name, email, phone: '+998901234567', password },
  })
}

async function approveSeller(client, admin, shop) {
  const application = await client('/seller-applications', {
    method: 'POST', status: 201,
    body: { shop, phone: '+998901234567', products: 'Test products' },
  })
  await admin(`/seller-applications/${application.id}`, {
    method: 'PATCH', body: { status: 'approved' },
  })
  assert.equal((await client('/me')).role, 'seller', 'An existing session must see admin approval')
}

function noSecrets(value) {
  for (const [key, item] of Object.entries(value ?? {})) {
    assert.ok(!/password|hash|salt|token|cookie|session/i.test(key), `Private field exposed: ${key}`)
    if (item && typeof item === 'object') noSecrets(item)
  }
  assert.ok(!JSON.stringify(value).includes(password))
}

test('chat delivery, privacy, account activity, and restart persistence', { timeout: 60_000 }, async (t) => {
  const app = await fixture(t)
  const guest = app.client()
  const admin = app.client()
  const buyer = app.client()
  const seller = app.client()
  const stranger = app.client()
  const secondSeller = app.client()

  await guest('/admin/accounts', { status: 401 })
  const adminUser = await admin('/login', {
    method: 'POST', body: { login: 'Ubaydulloh', password: '2013' },
  })
  assert.equal(adminUser.role, 'admin')

  const buyerUser = await register(buyer, 'Bir xil ism', 'buyer@example.test')
  const sellerUser = await register(seller, 'Sotuvchi Test', 'seller@example.test')
  const strangerUser = await register(stranger, 'Bir xil ism', 'stranger@example.test')
  const secondSellerUser = await register(secondSeller, 'Ikkinchi Sotuvchi', 'seller2@example.test')
  assert.notEqual(buyerUser.id, strangerUser.id, 'Identical display names must not share identity')
  for (const user of [buyerUser, sellerUser, strangerUser, secondSellerUser]) noSecrets(user)
  assert.equal((await buyer('/me')).id, buyerUser.id)

  await t.test('registration is persisted and admin-only account endpoints do not leak', async () => {
    await guest('/register', {
      method: 'POST', status: 409,
      body: { name: 'Duplicate', email: 'BUYER@example.test', phone: '+998901234567', password },
    })
    for (const path of ['/admin/accounts', '/users', '/login-events']) {
      await buyer(path, { status: 403 })
    }
    await buyer('/users/' + sellerUser.id, { status: 403 })
    const accounts = await admin('/admin/accounts')
    noSecrets(accounts)
    assert.equal(accounts.stats.registeredUsers, 4)
    assert.equal(accounts.stats.totalAccounts, 5)
    const savedBuyer = accounts.users.find((user) => user.id === buyerUser.id)
    assert.equal(savedBuyer.name, buyerUser.name)
    assert.equal(savedBuyer.email, buyerUser.email)
    assert.equal(savedBuyer.phone, buyerUser.phone)
    assert.ok(savedBuyer.createdAt)
    assert.ok(savedBuyer.lastLoginAt)
    assert.equal(savedBuyer.loginCount, 1)
    assert.ok(accounts.events.some((event) => event.userId === buyerUser.id && event.type === 'register'))
    const saved = await app.saved()
    assert.notEqual(saved.users.find((user) => user.id === buyerUser.id).password, password)
  })

  await approveSeller(seller, admin, 'Test Electronics')
  await approveSeller(secondSeller, admin, 'Test Books')

  let conversation
  await t.test('approved seller receives a buyer message and buyer receives the reply', async () => {
    const shops = await admin('/shops')
    assert.ok(shops.some((shop) => shop.userId === sellerUser.id || shop.sellerId === sellerUser.id || shop.id === sellerUser.id))
    conversation = await buyer('/conversations', {
      method: 'POST', status: 201,
      body: { sellerId: sellerUser.id, productId: 'test-phone', productName: 'Test phone' },
    })
    assert.ok(conversation.id)
    const reopened = await buyer('/conversations', {
      method: 'POST', status: 201,
      body: { sellerId: sellerUser.id, productId: 'test-laptop', productName: 'Another product' },
    })
    assert.equal(reopened.id, conversation.id, 'Opening another product must keep the same buyer–seller chat')
    const sent = await buyer(`/conversations/${conversation.id}/messages`, {
      method: 'POST', status: 201,
      body: { text: 'Assalomu alaykum, mahsulot bormi?', senderId: sellerUser.id, from: 'Forged seller' },
    })
    assert.equal(sent.senderId, buyerUser.id, 'Server must derive sender from session')
    assert.equal(sent.text, 'Assalomu alaykum, mahsulot bormi?')
    const received = await seller(`/conversations/${conversation.id}/messages`)
    assert.ok(received.some((message) => message.id === sent.id))
    const sellerInbox = await seller('/conversations')
    assert.equal(sellerInbox.find((thread) => thread.id === conversation.id).unreadCount, 1)
    await seller(`/conversations/${conversation.id}/read`, { method: 'PATCH' })
    assert.equal((await seller('/conversations')).find((thread) => thread.id === conversation.id).unreadCount, 0)

    const reply = await seller(`/conversations/${conversation.id}/messages`, {
      method: 'POST', status: 201, body: { text: 'Va alaykum assalom, ha bor.' },
    })
    assert.equal(reply.senderId, sellerUser.id)
    const buyerMessages = await buyer(`/conversations/${conversation.id}/messages`)
    assert.ok(buyerMessages.some((message) => message.id === reply.id))
    assert.equal((await buyer('/conversations')).find((thread) => thread.id === conversation.id).unreadCount, 1)
    await buyer(`/conversations/${conversation.id}/read`, { method: 'PATCH' })
    assert.equal((await buyer('/conversations')).find((thread) => thread.id === conversation.id).unreadCount, 0)
  })

  await t.test('private conversations cannot be read, written, or marked read by unrelated accounts', async () => {
    for (const user of [stranger, secondSeller]) {
      assert.equal((await user('/conversations')).length, 0)
      await user(`/conversations/${conversation.id}/messages`, { status: 404 })
      await user(`/conversations/${conversation.id}/messages`, {
        method: 'POST', status: 404, body: { text: 'Not a participant', userId: buyerUser.id },
      })
      await user(`/conversations/${conversation.id}/read`, { method: 'PATCH', status: 404 })
    }
    await guest(`/conversations/${conversation.id}/messages`, { status: 401 })
    await guest('/messages?userId=' + buyerUser.id, { status: 401 })
    await buyer('/messages?userId=' + strangerUser.id, { status: 410 })
    await buyer('/messages', { method: 'POST', status: 410, body: { userId: strangerUser.id, text: 'Old endpoint' } })
    await buyer(`/conversations/${conversation.id}/messages`, {
      method: 'POST', status: 400, body: { text: '   ' },
    })
    await buyer('/conversations', { method: 'POST', status: 404, body: { sellerId: strangerUser.id } })
    const otherThread = await stranger('/conversations', {
      method: 'POST', status: 201, body: { sellerId: sellerUser.id },
    })
    assert.notEqual(otherThread.id, conversation.id)
    await buyer(`/conversations/${otherThread.id}/messages`, { status: 404 })
  })

  await t.test('concurrent sends retain every message with unique IDs', async () => {
    const sent = await Promise.all(Array.from({ length: 12 }, (_, index) => buyer(
      `/conversations/${conversation.id}/messages`,
      { method: 'POST', status: 201, body: { text: `Concurrent message ${index}` } },
    )))
    assert.equal(new Set(sent.map((message) => message.id)).size, sent.length)
    const messages = await seller(`/conversations/${conversation.id}/messages`)
    for (const message of sent) assert.ok(messages.some((saved) => saved.id === message.id))
  })

  await t.test('retrying the same send does not duplicate the message', async () => {
    const body = { text: 'Network retry test', clientId: 'test-client-message-1' }
    const first = await buyer(`/conversations/${conversation.id}/messages`, { method: 'POST', status: 201, body })
    const retried = await buyer(`/conversations/${conversation.id}/messages`, { method: 'POST', body })
    assert.equal(retried.id, first.id)
    const messages = await seller(`/conversations/${conversation.id}/messages`)
    assert.equal(messages.filter((message) => message.text === body.text).length, 1)
  })

  await t.test('logout invalidates the session and login activity is visible to admin', async () => {
    await buyer('/logout', { method: 'POST' })
    await buyer('/me', { status: 401 })
    await buyer('/conversations', { status: 401 })
    const loggedIn = await buyer('/login', {
      method: 'POST', body: { login: 'buyer@example.test', password },
    })
    assert.equal(loggedIn.id, buyerUser.id)
    const accounts = await admin('/admin/accounts')
    noSecrets(accounts)
    const updated = accounts.users.find((user) => user.id === buyerUser.id)
    assert.equal(updated.loginCount, 2)
    assert.ok(accounts.events.some((event) => event.userId === buyerUser.id && event.login === 'buyer@example.test'))
  })

  await t.test('messages, seller approval, and sign-in counts survive a server restart', async () => {
    const before = await buyer(`/conversations/${conversation.id}/messages`)
    await app.restart()
    await buyer('/login', { method: 'POST', body: { login: 'buyer@example.test', password } })
    await seller('/login', { method: 'POST', body: { login: 'seller@example.test', password } })
    assert.equal((await seller('/me')).role, 'seller')
    const after = await buyer(`/conversations/${conversation.id}/messages`)
    assert.deepEqual(after.map((message) => [message.id, message.text]), before.map((message) => [message.id, message.text]))
    await admin('/login', { method: 'POST', body: { login: 'Ubaydulloh', password: '2013' } })
    const accounts = await admin('/admin/accounts')
    assert.equal(accounts.users.find((user) => user.id === buyerUser.id).loginCount, 3)
    noSecrets(accounts)
  })
})

test('legacy plaintext login upgrades the password without exposing it', { timeout: 30_000 }, async (t) => {
  const app = await fixture(t, {
    users: [{ id: 17, name: 'Legacy account', email: 'legacy@example.test', phone: '+998901234567', password, role: 'buyer', createdAt: '2025-01-01T00:00:00.000Z' }],
    orders: [], sellerApplications: [], reviews: [], messages: [], wallets: {}, withdrawals: [], loginEvents: [],
  })
  const client = app.client()
  const user = await client('/login', { method: 'POST', body: { login: 'legacy@example.test', password } })
  assert.equal(user.id, 17)
  noSecrets(user)
  const stored = (await app.saved()).users.find((entry) => entry.id === 17)
  assert.notEqual(stored.password, password)
  assert.match(stored.password, /^[a-f\d]+:[a-f\d]+$/i)
  await app.restart()
  assert.equal((await client('/login', { method: 'POST', body: { login: 'legacy@example.test', password } })).id, 17)
})

test('existing resolvable chat history is migrated once and preserved', { timeout: 30_000 }, async (t) => {
  const app = await fixture(t, {
    users: [
      { id: 21, name: 'Legacy Buyer', email: 'old-buyer@example.test', phone: '+998901234567', password, role: 'buyer' },
      { id: 22, name: 'Legacy Seller', email: 'old-seller@example.test', phone: '+998901234568', password, role: 'seller' },
    ],
    sellerApplications: [{ id: 23, userId: 22, shop: 'Original Shop', status: 'approved' }],
    messages: [
      { id: 101, userId: 21, seller: 'Original Shop', from: 'Legacy Buyer', text: 'Earlier question', createdAt: '2025-01-01T10:00:00.000Z' },
      { id: 102, userId: 21, seller: 'Original Shop', from: 'Legacy Seller', text: 'Earlier reply', createdAt: '2025-01-01T10:01:00.000Z' },
      { id: 103, userId: 999, seller: 'Original Shop', from: 'Unknown account', text: 'Unresolvable archived message', createdAt: '2025-01-01T10:02:00.000Z' },
    ],
  })
  const buyer = app.client()
  const seller = app.client()
  await buyer('/login', { method: 'POST', body: { login: 'old-buyer@example.test', password } })
  await seller('/login', { method: 'POST', body: { login: 'old-seller@example.test', password } })
  const conversations = await buyer('/conversations')
  assert.equal(conversations.length, 1)
  const path = `/conversations/${conversations[0].id}/messages`
  const messages = await buyer(path)
  assert.deepEqual(messages.map((message) => [message.senderId, message.text]), [[21, 'Earlier question'], [22, 'Earlier reply']])
  assert.deepEqual(await seller(path), messages)
  await app.restart()
  await buyer('/login', { method: 'POST', body: { login: 'old-buyer@example.test', password } })
  assert.deepEqual(await buyer(path), messages, 'Migration must not duplicate existing messages')
  const saved = await app.saved()
  assert.equal(saved.messages.length, 3, 'Original history including unresolved entries must remain archived')
  assert.equal(saved.chatMessages.length, 2)
})
