export async function api(path, options = {}) {
  let response
  const timeout = typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(15000) : null
  const signal = options.signal && timeout && typeof AbortSignal.any === 'function'
    ? AbortSignal.any([options.signal, timeout])
    : options.signal || timeout || undefined
  try {
    response = await fetch('/api' + path, {
      ...options,
      signal,
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', ...options.headers },
    })
  } catch (cause) {
    if (cause.name === 'TimeoutError') throw new Error('Server javobi kechikdi. Qayta urinib ko‘ring.')
    if (cause.name === 'AbortError' && options.signal?.aborted) throw cause
    throw new Error('Server bilan aloqa uzildi. Qayta urinib ko‘ring.')
  }
  let data
  try {
    data = await response.json()
  } catch {
    throw new Error('Server javob bermayapti. Saytni qayta ishga tushiring.')
  }
  if (!response.ok) {
    const error = new Error(data.error || 'So‘rov bajarilmadi')
    error.status = response.status
    if (response.status === 401 && !['/login', '/register', '/me'].includes(path)) {
      window.dispatchEvent(new Event('bozor-session-expired'))
    }
    throw error
  }
  return data
}

const realtimeListeners = new Set()
let eventSource = null

function ensureRealtime() {
  if (eventSource || typeof EventSource === 'undefined' || !realtimeListeners.size) return
  eventSource = new EventSource('/api/events')
  eventSource.addEventListener('change', () => {
    for (const listener of realtimeListeners) listener()
  })
  eventSource.addEventListener('ready', () => {
    for (const listener of realtimeListeners) listener()
  })
  eventSource.onerror = () => {
    // EventSource reconnects automatically. Polling in consumers remains a fallback.
  }
}

export function subscribeRealtime(listener) {
  realtimeListeners.add(listener)
  ensureRealtime()
  return () => {
    realtimeListeners.delete(listener)
    if (!realtimeListeners.size && eventSource) {
      eventSource.close()
      eventSource = null
    }
  }
}
