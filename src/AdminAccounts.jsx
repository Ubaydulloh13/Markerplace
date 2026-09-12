import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api, subscribeRealtime } from './api.js'
import { localeFor, useI18n } from './i18n.jsx'
import './admin-accounts.css'

const PAGE_SIZE = 12
function formatDate(value, lang, fallback) {
  if (!value) return fallback
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? fallback : date.toLocaleString(localeFor(lang), {
    day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
  })
}

function count(value, lang) {
  return Number.isFinite(value) ? value.toLocaleString(localeFor(lang)) : '—'
}

function AccountDetails({ account, events }) {
  const {t,lang}=useI18n()
  const shopLabels = { approved: t('approved'), pending: t('underReview'), rejected: t('rejected') }
  const shops = Array.isArray(account.shops) ? account.shops : []
  return <div className="aa-details" id={`account-details-${account.id}`}>
    <section aria-label={t('accountInformation')}>
      <h3>{t('accountInformation')}</h3>
      <dl className="aa-properties">
        <div><dt>{t('userId')}</dt><dd>{account.id}</dd></div>
        <div><dt>Email</dt><dd>{account.email || t('notEntered')}</dd></div>
        <div><dt>{t('phone')}</dt><dd>{account.phone || t('notEntered')}</dd></div>
        <div><dt>{t('registeredAt')}</dt><dd>{formatDate(account.createdAt,lang,t('notRecorded'))}</dd></div>
        <div><dt>{t('lastLogin')}</dt><dd>{formatDate(account.lastLoginAt,lang,t('notRecorded'))}</dd></div>
        <div><dt>{t('loginCount')}</dt><dd>{count(account.loginCount,lang)}</dd></div>
        <div><dt>{t('password')}</dt><dd>{t('protectedPassword')}</dd></div>
      </dl>
      <h3>{t('storesApplications')} <span>{shops.length}</span></h3>
      {shops.length ? <ul className="aa-shops">{shops.map(shop => <li key={shop.id}>
        <div><strong>{shop.shop || t('unnamedStore')}</strong><span className={`aa-shop-state aa-shop-${shop.status}`}>{shopLabels[shop.status] || shop.status || t('notEntered')}</span></div>
        <p>{shop.products || t('notEntered')}</p>
        <small>{shop.phone || t('notEntered')} · {formatDate(shop.createdAt,lang,t('notRecorded'))}</small>
      </li>)}</ul> : <p className="aa-muted">{t('noSellerApplication')}</p>}
    </section>
    <section aria-label={t('loginHistory')}>
      <h3>{t('loginHistory')} <span>{events.length}</span></h3>
      <p className="aa-muted aa-history-note">{t('historyNote')}</p>
      {events.length ? <ol className="aa-events">{events.map(event => <li key={event.id}>
        <span className={`aa-event-dot ${event.type === 'register' ? 'aa-register-dot' : ''}`} aria-hidden="true" />
        <div><strong>{event.type === 'register' ? t('registeredEvent') : t('loginEvent')}</strong><span>Login: {event.login || t('notRecorded')}</span><time dateTime={event.at}>{formatDate(event.at,lang,t('notRecorded'))}</time></div>
      </li>)}</ol> : <p className="aa-muted">{t('noLoginEvents')}</p>}
    </section>
  </div>
}

export default function AdminAccounts() {
  const {t,lang}=useI18n()
  const roleLabels = { admin: t('admin'), seller: t('sellerRole'), buyer: t('buyer') }
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
    const unsubscribe = subscribeRealtime(refresh)
    const interval = setInterval(refresh, 20000)
    return () => { mounted.current = false; unsubscribe(); clearTimeout(initialRefresh); clearInterval(interval) }
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
      <div><span className="aa-eyebrow">{t('adminEyebrow')}</span><h2 id="aa-heading">{t('users')}</h2><p>{t('usersDescription')}</p></div>
      <button className="aa-refresh" type="button" disabled={refreshing} onClick={() => { setRefreshing(true); refresh() }}>{refreshing ? t('refreshing') : `↻ ${t('refresh')}`}</button>
    </div>
    {error && <div className="aa-error" role="alert">{error}{data && <span>Quyida oxirgi olingan ma’lumotlar ko‘rsatilmoqda.</span>}</div>}
    {!data && !error ? <div className="aa-empty" role="status"><span className="aa-loading-dot" />{t('loadingUsers')}</div> : data && <>
      <div className="aa-stats">
        <div><span>{t('registeredUsers')}</span><strong>{count(stats.registeredUsers,lang)}</strong><small>{t('totalAccounts')}</small></div>
        <div><span>{t('signedInUsers')}</span><strong>{count(stats.uniqueSignedInUsers,lang)}</strong><small>{t('distinctUsers')}</small></div>
        <div><span>{t('totalLogins')}</span><strong>{count(stats.totalLogins,lang)}</strong><small>{t('loginHistory')}</small></div>
        <div><span>{t('sellers')}</span><strong>{count(stats.sellerCount,lang)}</strong><small>{t('sellerRole')}</small></div>
      </div>
      <div className="aa-toolbar">
        <label className="aa-search"><span>{t('searchUser')}</span><input type="search" value={query} onChange={event => { setQuery(event.target.value); setPage(1) }} placeholder={t('searchUserPlaceholder')} /></label>
        <label className="aa-role-filter"><span>{t('accountType')}</span><select value={role} onChange={event => { setRole(event.target.value); setPage(1) }}><option value="all">{t('allAccounts')}</option><option value="buyer">{t('buyers')}</option><option value="seller">{t('sellers')}</option><option value="admin">{t('superAdmins')}</option></select></label>
      </div>
      <div className="aa-results-meta"><span>{count(users.length,lang)} {t('accounts')} {query || role !== 'all' ? t('found') : ''}</span><span>{t('autoRefresh')}: 20 {t('seconds')} · {updatedAt?.toLocaleTimeString(localeFor(lang), { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</span></div>
      {visibleUsers.length ? <ul className="aa-list">{visibleUsers.map(account => {
        const isExpanded = expanded.has(account.id)
        return <li className="aa-account" key={account.id}>
          <div className="aa-account-summary">
            <div className="aa-person"><span className="aa-avatar" aria-hidden="true">{(account.name || account.login || '?').trim().slice(0, 1).toUpperCase()}</span><div><strong>{account.name || t('notEntered')}</strong><span>Login: {account.login || account.email || t('notEntered')}</span></div></div>
            <span className={`aa-role aa-role-${account.role}`}>{roleLabels[account.role] || account.role}</span>
            <div className="aa-last-login"><small>{t('lastLogin')}</small><span>{formatDate(account.lastLoginAt,lang,t('notRecorded'))}</span></div>
            <button className="aa-detail-toggle" type="button" aria-expanded={isExpanded} aria-controls={`account-details-${account.id}`} onClick={() => toggleAccount(account.id)}>{isExpanded ? `${t('close')} −` : `${t('details')} +`}</button>
          </div>
          {isExpanded && <AccountDetails account={account} events={eventsByUser.get(String(account.id)) || []} />}
        </li>
      })}</ul> : <div className="aa-empty"><h3>{query || role !== 'all' ? t('noMatchingAccount') : t('noAccounts')}</h3><p>{query || role !== 'all' ? t('changeFilters') : t('newUsersAppear')}</p>{(query || role !== 'all') && <button type="button" onClick={() => { setQuery(''); setRole('all'); setPage(1) }}>{t('clearFilters')}</button>}</div>}
      {totalPages > 1 && <div className="aa-pagination"><button type="button" disabled={currentPage === 1} onClick={() => setPage(currentPage - 1)}>← {t('previous')}</button><span>{currentPage} / {totalPages} {t('page')}</span><button type="button" disabled={currentPage === totalPages} onClick={() => setPage(currentPage + 1)}>{t('next')} →</button></div>}
    </>}
  </section>
}
