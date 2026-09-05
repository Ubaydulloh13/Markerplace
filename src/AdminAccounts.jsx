import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api } from './api.js'
import './admin-accounts.css'

const PAGE_SIZE = 12
const roleLabels = { admin: 'Katta admin', seller: 'Sotuvchi', buyer: 'Xaridor' }
const shopLabels = { approved: 'Tasdiqlangan', pending: 'Tekshirilmoqda', rejected: 'Rad etilgan' }

function formatDate(value) {
  if (!value) return 'Qayd qilinmagan'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? 'Qayd qilinmagan' : date.toLocaleString('uz-UZ', {
    day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
  })
}

function count(value) {
  return Number.isFinite(value) ? value.toLocaleString('uz-UZ') : '—'
}

function AccountDetails({ account, events }) {
  const shops = Array.isArray(account.shops) ? account.shops : []
  return <div className="aa-details" id={`account-details-${account.id}`}>
    <section aria-label="Hisob ma’lumotlari">
      <h3>Hisob ma’lumotlari</h3>
      <dl className="aa-properties">
        <div><dt>Foydalanuvchi ID</dt><dd>{account.id}</dd></div>
        <div><dt>Email</dt><dd>{account.email || 'Kiritilmagan'}</dd></div>
        <div><dt>Telefon</dt><dd>{account.phone || 'Kiritilmagan'}</dd></div>
        <div><dt>Ro‘yxatdan o‘tgan</dt><dd>{formatDate(account.createdAt)}</dd></div>
        <div><dt>Oxirgi kirish</dt><dd>{formatDate(account.lastLoginAt)}</dd></div>
        <div><dt>Hisobga kirishlar</dt><dd>{count(account.loginCount)}</dd></div>
        <div><dt>Parol</dt><dd>Himoyalangan, ko‘rsatib bo‘lmaydi</dd></div>
      </dl>
      <h3>Do‘konlar va arizalar <span>{shops.length}</span></h3>
      {shops.length ? <ul className="aa-shops">{shops.map(shop => <li key={shop.id}>
        <div><strong>{shop.shop || 'Nomsiz do‘kon'}</strong><span className={`aa-shop-state aa-shop-${shop.status}`}>{shopLabels[shop.status] || shop.status || 'Holati kiritilmagan'}</span></div>
        <p>{shop.products || 'Mahsulot turlari kiritilmagan'}</p>
        <small>{shop.phone || 'Telefon kiritilmagan'} · {formatDate(shop.createdAt)}</small>
      </li>)}</ul> : <p className="aa-muted">Do‘kon yoki sotuvchi arizasi yo‘q.</p>}
    </section>
    <section aria-label="Ro‘yxatdan o‘tish va kirish tarixi">
      <h3>Kirish tarixi <span>{events.length}</span></h3>
      <p className="aa-muted aa-history-note">Ro‘yxatdan o‘tish va keyingi kirishlar alohida qayd etiladi. Eski kirishlar tarixda bo‘lmasligi mumkin.</p>
      {events.length ? <ol className="aa-events">{events.map(event => <li key={event.id}>
        <span className={`aa-event-dot ${event.type === 'register' ? 'aa-register-dot' : ''}`} aria-hidden="true" />
        <div><strong>{event.type === 'register' ? 'Ro‘yxatdan o‘tdi' : 'Hisobiga kirdi'}</strong><span>Login: {event.login || 'Qayd qilinmagan'}</span><time dateTime={event.at}>{formatDate(event.at)}</time></div>
      </li>)}</ol> : <p className="aa-muted">Bu hisob uchun hali kirish voqealari qayd qilinmagan.</p>}
    </section>
  </div>
}

export default function AdminAccounts() {
  const [data, setData] = useState(null)
  const [error, setError] = useState('')
  const [refreshing, setRefreshing] = useState(true)
  const [updatedAt, setUpdatedAt] = useState(null)
  const [query, setQuery] = useState('')
  const [role, setRole] = useState('all')
  const [page, setPage] = useState(1)
  const [expanded, setExpanded] = useState(new Set())
  const mounted = useRef(false)
  const pending = useRef(false)

  const refresh = useCallback(async () => {
    if (pending.current) return
    pending.current = true
    try {
      const result = await api('/admin/accounts')
      if (!Array.isArray(result.users) || !Array.isArray(result.events)) throw new Error('Foydalanuvchilar ma’lumotini olishda xato yuz berdi.')
      if (mounted.current) {
        setData(result)
        setError('')
        setUpdatedAt(new Date())
      }
    } catch (err) {
      if (mounted.current) setError(err.message || 'Server bilan bog‘lanib bo‘lmadi. Qayta urinib ko‘ring.')
    } finally {
      pending.current = false
      if (mounted.current) setRefreshing(false)
    }
  }, [])

  useEffect(() => {
    mounted.current = true
    const initialRefresh = setTimeout(refresh, 0)
    const interval = setInterval(refresh, 10000)
    return () => { mounted.current = false; clearTimeout(initialRefresh); clearInterval(interval) }
  }, [refresh])

  const users = useMemo(() => {
    const term = query.trim().toLocaleLowerCase()
    return (data?.users || []).filter(account =>
      (role === 'all' || account.role === role) && (!term || [account.name, account.login, account.email, account.phone, account.id].some(value =>
        String(value ?? '').toLocaleLowerCase().includes(term))))
  }, [data, query, role])

  const eventsByUser = useMemo(() => {
    const byUser = new Map()
    for (const event of data?.events || []) {
      const id = String(event.userId)
      if (!byUser.has(id)) byUser.set(id, [])
      byUser.get(id).push(event)
    }
    for (const events of byUser.values()) events.sort((a, b) => new Date(b.at) - new Date(a.at))
    return byUser
  }, [data])

  const totalPages = Math.max(1, Math.ceil(users.length / PAGE_SIZE))
  const currentPage = Math.min(page, totalPages)
  const visibleUsers = users.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE)
  const stats = data?.stats || {}
  const toggleAccount = id => setExpanded(previous => {
    const next = new Set(previous)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    return next
  })

  return <section className="admin-accounts" aria-labelledby="aa-heading">
    <div className="aa-heading">
      <div><span className="aa-eyebrow">KATTA ADMIN</span><h2 id="aa-heading">Foydalanuvchilar</h2><p>Ro‘yxatdan o‘tgan hisoblar, do‘konlar va kirishlar tarixi.</p></div>
      <button className="aa-refresh" type="button" disabled={refreshing} onClick={() => { setRefreshing(true); refresh() }}>{refreshing ? 'Yangilanmoqda…' : '↻ Yangilash'}</button>
    </div>
    {error && <div className="aa-error" role="alert">{error}{data && <span>Quyida oxirgi olingan ma’lumotlar ko‘rsatilmoqda.</span>}</div>}
    {!data && !error ? <div className="aa-empty" role="status"><span className="aa-loading-dot" />Foydalanuvchilar yuklanmoqda…</div> : data && <>
      <div className="aa-stats">
        <div><span>Ro‘yxatdan o‘tganlar</span><strong>{count(stats.registeredUsers)}</strong><small>Jami hisoblar</small></div>
        <div><span>Hisobiga kirganlar</span><strong>{count(stats.uniqueSignedInUsers)}</strong><small>Alohida foydalanuvchilar</small></div>
        <div><span>Jami kirishlar</span><strong>{count(stats.totalLogins)}</strong><small>Ro‘yxatdan o‘tishdan tashqari</small></div>
        <div><span>Sotuvchilar</span><strong>{count(stats.sellerCount)}</strong><small>Sotuvchi rolidagi hisoblar</small></div>
      </div>
      <div className="aa-toolbar">
        <label className="aa-search"><span>Foydalanuvchini qidirish</span><input type="search" value={query} onChange={event => { setQuery(event.target.value); setPage(1) }} placeholder="Ism, login, email yoki telefon" /></label>
        <label className="aa-role-filter"><span>Hisob turi</span><select value={role} onChange={event => { setRole(event.target.value); setPage(1) }}><option value="all">Barcha hisoblar</option><option value="buyer">Xaridorlar</option><option value="seller">Sotuvchilar</option><option value="admin">Katta adminlar</option></select></label>
      </div>
      <div className="aa-results-meta"><span>{count(users.length)} ta hisob{query || role !== 'all' ? ' topildi' : ''}</span><span>Avtomatik yangilash: 10 soniya · {updatedAt?.toLocaleTimeString('uz-UZ', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</span></div>
      {visibleUsers.length ? <ul className="aa-list">{visibleUsers.map(account => {
        const isExpanded = expanded.has(account.id)
        return <li className="aa-account" key={account.id}>
          <div className="aa-account-summary">
            <div className="aa-person"><span className="aa-avatar" aria-hidden="true">{(account.name || account.login || '?').trim().slice(0, 1).toUpperCase()}</span><div><strong>{account.name || 'Ism kiritilmagan'}</strong><span>Login: {account.login || account.email || 'Kiritilmagan'}</span></div></div>
            <span className={`aa-role aa-role-${account.role}`}>{roleLabels[account.role] || account.role}</span>
            <div className="aa-last-login"><small>Oxirgi kirish</small><span>{formatDate(account.lastLoginAt)}</span></div>
            <button className="aa-detail-toggle" type="button" aria-expanded={isExpanded} aria-controls={`account-details-${account.id}`} onClick={() => toggleAccount(account.id)} aria-label={`${account.name || account.login} ma’lumotlari`}>{isExpanded ? 'Yopish −' : 'Batafsil +'}</button>
          </div>
          {isExpanded && <AccountDetails account={account} events={eventsByUser.get(String(account.id)) || []} />}
        </li>
      })}</ul> : <div className="aa-empty"><h3>{query || role !== 'all' ? 'Mos hisob topilmadi' : 'Hali hisoblar mavjud emas'}</h3><p>{query || role !== 'all' ? 'Qidiruvni yoki hisob turini o‘zgartiring.' : 'Yangi foydalanuvchilar ro‘yxatdan o‘tgach shu yerda ko‘rinadi.'}</p>{(query || role !== 'all') && <button type="button" onClick={() => { setQuery(''); setRole('all'); setPage(1) }}>Filtrlarni tozalash</button>}</div>}
      {totalPages > 1 && <div className="aa-pagination" aria-label="Foydalanuvchilar sahifalari"><button type="button" disabled={currentPage === 1} onClick={() => setPage(currentPage - 1)}>← Oldingi</button><span>{currentPage} / {totalPages} sahifa</span><button type="button" disabled={currentPage === totalPages} onClick={() => setPage(currentPage + 1)}>Keyingi →</button></div>}
    </>}
  </section>
}
