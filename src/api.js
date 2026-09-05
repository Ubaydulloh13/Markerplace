export async function api(path, options = {}) {
  let response
  try {
    response = await fetch('/api' + path, {
      ...options,
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', ...options.headers },
    })
  } catch (cause) {
    if (cause.name === 'AbortError') throw cause
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
