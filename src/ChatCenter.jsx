import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from './api.js'
import './chat.css'

const same = (a, b) => String(a) === String(b)
const clock = date => date ? new Date(date).toLocaleTimeString('uz-UZ', { hour: '2-digit', minute: '2-digit' }) : ''
const partner = (conversation, user) => same(conversation.sellerId, user.id) ? conversation.buyerName : conversation.shopName || conversation.sellerName

export function ChatShortcut({ onOpen, user }) {
  const [count, setCount] = useState(0)
  useEffect(() => {
    let active = true
    const update = () => api('/conversations').then(items => {
      if (active) setCount(items.reduce((sum, item) => sum + item.unreadCount, 0))
    }).catch(() => {})
    update()
    const interval = setInterval(update, 4000)
    return () => { active = false; clearInterval(interval) }
  }, [user.id])
  return <button className="chatShortcut" onClick={onOpen} aria-label={`Chatlar${count ? `, ${count} yangi xabar` : ''}`}>
    <span aria-hidden="true">✉</span><small>Chatlar</small>{count > 0 && <i>{count}</i>}
  </button>
}

export default function ChatCenter({ user, target, compact = false }) {
  const [conversations, setConversations] = useState([])
  const [shops, setShops] = useState([])
  const [selected, setSelected] = useState(null)
  const [query, setQuery] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [starting, setStarting] = useState(false)
  const [retry, setRetry] = useState(0)
  const [showShops, setShowShops] = useState(false)
  const alive = useRef(true)
  const sellerId = target?.sellerId
  const seller = target?.seller
  const productId = target?.productId
  const productName = target?.productName

  const refresh = useCallback(async () => {
    try {
      const items = await api('/conversations')
      if (alive.current) { setConversations(items); setError('') }
    } catch (err) {
      if (alive.current) setError(err.message)
    } finally {
      if (alive.current) setLoading(false)
    }
  }, [])

  useEffect(() => {
    alive.current = true
    refresh()
    const interval = setInterval(refresh, 3000)
    const focus = () => refresh()
    window.addEventListener('focus', focus)
    return () => { alive.current = false; clearInterval(interval); window.removeEventListener('focus', focus) }
  }, [refresh, user.id])

  useEffect(() => {
    if (!showShops) return
    let active = true
    api('/shops').then(data => { if (active) setShops(data) }).catch(err => { if (active) setError(err.message) })
    return () => { active = false }
  }, [showShops])

  // Opening a product chat resolves its seller on the server, never from a display name on the client.
  useEffect(() => {
    if (!sellerId && !seller) return
    let active = true
    setStarting(true)
    api('/conversations', { method: 'POST', body: JSON.stringify({ sellerId, seller, productId, productName }) })
      .then(conversation => {
        if (!active) return
        setSelected(conversation)
        setError('')
        refresh()
      })
      .catch(err => { if (active) setError(err.message) })
      .finally(() => { if (active) setStarting(false) })
    return () => { active = false }
  }, [sellerId, seller, productId, productName, retry, refresh])

  const start = async shop => {
    if (starting) return
    setStarting(true)
    setError('')
    try {
      const conversation = await api('/conversations', { method: 'POST', body: JSON.stringify({ sellerId: shop.sellerId }) })
      setSelected(conversation)
      setShowShops(false)
      await refresh()
    } catch (err) { setError(err.message) }
    finally { setStarting(false) }
  }

  const visible = conversations.filter(item => `${partner(item, user)} ${item.productName || ''} ${item.lastMessage?.text || ''}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()))
  const current = conversations.find(item => item.id === selected?.id) || selected

  return <section className={`messenger ${compact ? 'messengerCompact' : ''} ${current ? 'hasConversation' : ''}`} aria-label="Xaridor va sotuvchi chatlari">
    {!compact && <div className="conversationList">
      <div className="messengerHeading"><h2>Chatlar</h2><button onClick={() => setShowShops(value => !value)} aria-label={showShops ? 'Suhbatlarga qaytish' : 'Yangi suhbat'}>{showShops ? '←' : '+'}</button></div>
      <label className="chatSearch"><span className="srOnly">Suhbatlarni qidirish</span><input placeholder="Ism yoki do‘konni qidiring" value={query} onChange={e => setQuery(e.target.value)} /></label>
      {loading && <p className="chatNotice" role="status">Suhbatlar yuklanmoqda…</p>}
      {showShops ? <div className="shopContacts"><p className="chatNotice">Do‘konni tanlang</p>{shops.filter(shop => !same(shop.sellerId, user.id)).map(shop => <button key={shop.sellerId} onClick={() => start(shop)} disabled={starting}>
        <span className="contactAvatar">{(shop.shop || shop.name || '?')[0]}</span><span><b>{shop.shop || shop.name}</b><small>{shop.sellerName}</small></span>
      </button>)}</div> : <div className="conversationItems">{visible.map(item => <button key={item.id} className={item.id === current?.id ? 'selectedConversation' : ''} onClick={() => setSelected(item)}>
        <span className="contactAvatar">{partner(item, user)?.[0] || '?'}</span><span className="contactText"><b>{partner(item, user)}</b><small>{item.lastMessage?.text || item.productName || 'Suhbatni boshlang'}</small></span>
        <span className="contactMeta"><time>{clock(item.updatedAt)}</time>{item.unreadCount > 0 && <em>{item.unreadCount}</em>}</span>
      </button>)}{!loading && !visible.length && <p className="chatNotice">{query ? 'Suhbat topilmadi.' : 'Hozircha suhbat yo‘q. Mahsulotdagi “Chat” orqali yoki + tugmasidan boshlang.'}</p>}</div>}
    </div>}
    <div className="conversationPane">
      {error && <div className="chatError" role="alert">{error}<button onClick={() => target ? setRetry(value => value + 1) : refresh()}>Qayta urinish</button></div>}
      {starting && <p className="chatNotice" role="status">Suhbat ochilmoqda…</p>}
      {current ? <Conversation key={current.id} conversation={current} user={user} onRead={refresh} onBack={() => setSelected(null)} /> : !starting && <div className="chatEmpty"><span aria-hidden="true">✉</span><h3>Xabarlaringiz shu yerda</h3><p>{compact ? 'Sotuvchi hisobi bilan aloqa o‘rnatilgach, xabar yozishingiz mumkin.' : 'Suhbatni tanlang. Yangi xabarlar avtomatik ko‘rinadi.'}</p></div>}
    </div>
  </section>
}

function Conversation({ conversation, user, onRead, onBack }) {
  const [messages, setMessages] = useState([])
  const [draft, setDraft] = useState('')
  const [loading, setLoading] = useState(true)
  const [sending, setSending] = useState(false)
  const [error, setError] = useState('')
  const feed = useRef(null)
  const alive = useRef(true)
  const inFlight = useRef(false)
  const pendingSend = useRef(null)
  const endpoint = `/conversations/${encodeURIComponent(conversation.id)}`

  const refresh = useCallback(async () => {
    if (inFlight.current) return
    inFlight.current = true
    try {
      const items = await api(endpoint + '/messages')
      if (!alive.current) return
      const unread = items.some(message => !same(message.senderId, user.id) && !message.readAt)
      if (unread && document.visibilityState === 'visible') {
        await api(endpoint + '/read', { method: 'PATCH', body: '{}' })
        onRead()
      }
      if (alive.current) { setMessages(items); setError('') }
    } catch (err) { if (alive.current) setError(err.message) }
    finally { inFlight.current = false; if (alive.current) setLoading(false) }
  }, [endpoint, user.id, onRead])

  useEffect(() => {
    alive.current = true
    refresh()
    const interval = setInterval(refresh, 2500)
    return () => { alive.current = false; clearInterval(interval) }
  }, [refresh])
  useEffect(() => {
    if (feed.current) feed.current.scrollTop = feed.current.scrollHeight
  }, [messages.length])

  const send = async e => {
    e.preventDefault()
    const text = draft.trim()
    if (!text || sending) return
    setSending(true)
    setError('')
    if (!pendingSend.current || pendingSend.current.text !== text) {
      pendingSend.current = { text, clientId: crypto.randomUUID() }
    }
    try {
      const message = await api(endpoint + '/messages', { method: 'POST', body: JSON.stringify(pendingSend.current) })
      if (!alive.current) return
      setMessages(previous => previous.some(item => item.id === message.id) ? previous : [...previous, message])
      setDraft('')
      pendingSend.current = null
      onRead()
    } catch (err) { if (alive.current) setError(err.message) }
    finally { if (alive.current) setSending(false) }
  }

  return <>
    <div className="conversationHeading"><button className="chatBack" onClick={onBack} aria-label="Chatlar ro‘yxati">←</button><span className="contactAvatar">{partner(conversation, user)?.[0]}</span><div><h3>{partner(conversation, user)}</h3><small>{conversation.productName || 'Xaridor va sotuvchi suhbati'}</small></div><button className="chatRefresh" onClick={refresh} aria-label="Xabarlarni yangilash">↻</button></div>
    {error && <div className="chatError" role="alert">{error}</div>}
    <div className="messageFeed" ref={feed} role="log" aria-label="Suhbat xabarlari" aria-live="polite">
      {loading && <p className="chatNotice" role="status">Xabarlar yuklanmoqda…</p>}
      {!loading && !messages.length && <p className="chatNotice">Birinchi xabarni yozing.</p>}
      {messages.map(message => <div className={`messageBubble ${same(message.senderId, user.id) ? 'ownMessage' : ''}`} key={message.id}>
        <b>{message.senderName}</b><p>{message.text}</p><span><time dateTime={message.createdAt}>{clock(message.createdAt)}</time>{same(message.senderId, user.id) && <small title={message.readAt ? 'O‘qildi' : 'Yuborildi'}>{message.readAt ? '✓✓' : '✓'}</small>}</span>
      </div>)}
    </div>
    <form className="messageComposer" onSubmit={send}>
      <label><span className="srOnly">Xabar matni</span><textarea rows={2} maxLength={4000} placeholder="Xabar yozing…" value={draft} onChange={e => setDraft(e.target.value)} disabled={sending} onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); e.currentTarget.form.requestSubmit() } }} /></label>
      <button disabled={sending || !draft.trim()} type="submit" aria-label="Xabarni yuborish">{sending ? '…' : 'Yuborish ➤'}</button>
    </form>
  </>
}
