const $ = (id) => document.getElementById(id)
let current = null

function message(text, error = false) {
  $('message').textContent = text
  $('message').className = error ? 'error' : 'success'
}

function updateKeyHint() {
  if (!current) return
  let nextUrl = $('baseUrl').value.trim().replace(/\/+$/, '')
  try { nextUrl = new URL(nextUrl).toString().replace(/\/+$/, '') } catch { /* 输入中，保存时校验 */ }
  let previousUrl = current.baseUrl
  try { previousUrl = new URL(previousUrl).toString().replace(/\/+$/, '') } catch { /* 尚未配置 */ }
  const changed = nextUrl !== previousUrl
  $('apiKey').required = changed || !current.apiKeySet
  $('keyState').hidden = changed || !current.apiKeySet
  $('apiKey').placeholder = changed ? '填写新渠道的 API Key' : current.apiKeySet ? '留空继续使用已配置的密钥' : '填写该渠道的 API Key'
  $('keyHint').textContent = changed
    ? '服务地址已修改，请填写新渠道的 API Key。'
    : current.apiKeySet ? '已配置密钥；留空继续使用，输入新值可更换。已保存的密钥不会回显。' : '密钥保存在本机，保存后不会回显到页面。'
}

function populate(config) {
  current = config
  $('baseUrl').value = config.baseUrl
  $('model').value = config.model
  $('thinking').value = config.thinking
  $('contextWindow').value = config.contextWindow
  $('apiKey').value = ''
  $('apiKey').placeholder = config.apiKeySet ? '留空继续使用已配置的密钥' : '填写该渠道的 API Key'
  $('keyState').hidden = !config.apiKeySet
  $('saved').textContent = config.updatedAt ? `上次保存：${new Date(config.updatedAt).toLocaleString()}` : config.configured ? '已读取当前服务配置' : '请先配置模型服务'
  updateKeyHint()
}

async function request(options) {
  const response = await fetch('/api/model-config', { ...options, signal: AbortSignal.timeout(10000) })
  if (response.status === 404) throw new Error('后台版本尚不支持网页设置，请重启 tutor 服务后刷新页面')
  let result
  try { result = await response.json() } catch { throw new Error('无法读取后台响应，请重启 tutor 服务后刷新页面') }
  if (!response.ok || result.ok !== true) throw new Error(result.error || '模型设置请求失败')
  return result
}

$('baseUrl').addEventListener('input', updateKeyHint)
$('form').addEventListener('submit', async (event) => {
  event.preventDefault()
  const config = { baseUrl: $('baseUrl').value.trim(), model: $('model').value.trim(), apiKey: $('apiKey').value.trim(),
    thinking: $('thinking').value, contextWindow: Number($('contextWindow').value) }
  $('fields').disabled = true
  $('save').textContent = '保存中…'
  try {
    const result = await request({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(config) })
    populate(result.config)
    message(result.active
      ? `已保存。正在进行的「${result.active.courseId}」流程继续使用原配置；下一次开始流程时生效。`
      : '已保存。新开始的教学流程将使用此配置，无需重启服务。')
  } catch (error) {
    message(error.name === 'TimeoutError' ? '保存请求超时，请刷新页面确认是否保存成功' : error.message, true)
  } finally {
    $('fields').disabled = false
    $('save').textContent = '保存设置'
  }
})

request().then((result) => {
  populate(result.config)
  $('fields').disabled = false
}).catch((error) => message(error.name === 'TimeoutError' ? '连接后台超时，请确认服务已启动' : error.message, true))
