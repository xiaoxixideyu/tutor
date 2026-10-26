// 模型设置表单：独立设置页与单壳抽屉共用同一份逻辑。
(function () {
  const S = (window.TutorSettings = window.TutorSettings || {})

  const FIELDS = `
    <div class="field">
      <label for="baseUrl">服务地址（Base URL）</label>
      <input id="baseUrl" type="url" placeholder="https://api.example.com/v1" autocomplete="off" spellcheck="false" required maxlength="2048">
      <p class="hint">填写渠道提供的基础地址，通常以 /v1 结尾，不包含 /chat/completions。</p>
    </div>
    <div class="field">
      <label for="model">模型名称</label>
      <input id="model" placeholder="渠道提供的完整模型 ID" autocomplete="off" spellcheck="false" required maxlength="256">
      <p class="hint">名称必须与该渠道支持的模型 ID 一致。</p>
    </div>
    <div class="field">
      <label for="apiKey">API Key <span id="keyState" class="key-state" hidden>已配置</span></label>
      <input id="apiKey" type="password" placeholder="填写该渠道的 API Key" autocomplete="new-password" spellcheck="false" maxlength="8192">
      <p id="keyHint" class="hint">密钥保存在本机，保存后不会回显到页面。</p>
    </div>
    <div class="field">
      <label for="searchMcpUrl">教研搜索 MCP 地址（可选）</label>
      <input id="searchMcpUrl" type="url" placeholder="https://tavily.ivanli.cc/mcp" autocomplete="off" spellcheck="false" maxlength="2048">
      <p class="hint">联网教研的搜索服务（MCP over HTTP）。Tavily Hikari 填 <code>https://&lt;host&gt;/mcp</code>；留空沿用 .env 的 TUTOR_MCP_SEARCH_URL。</p>
    </div>
    <div class="field">
      <label for="searchToken">搜索服务 Token <span id="searchKeyState" class="key-state" hidden>已配置</span></label>
      <input id="searchToken" type="password" placeholder="填写该搜索服务的 Token" autocomplete="new-password" spellcheck="false" maxlength="8192">
      <p id="searchKeyHint" class="hint">Tavily Hikari 使用 th- 开头的访问令牌；密钥保存在本机，保存后不会回显。</p>
    </div>
    <details>
      <summary>高级设置</summary>
      <div class="field">
        <label for="thinking">推理模式</label>
        <select id="thinking">
          <option value="default">跟随服务默认（推荐）</option>
          <option value="on">开启推理</option>
          <option value="off">关闭推理</option>
        </select>
        <p class="hint">开启推理：DeepSeek 网关的 v 系列/flash 路由使用最高强度（同时下发 thinking 与 reasoning_effort=high），官方 chat/reasoner 仍按 thinking 开关，minimax 系列为中强度。关闭推理可能影响教学与审查质量；其他模型请使用服务默认。</p>
      </div>
      <div class="field">
        <label for="contextWindow">上下文长度（token）</label>
        <input id="contextWindow" type="number" min="1024" max="2000000" step="1" value="262144" required>
        <p class="hint">按渠道说明填写，用于限制单次请求可容纳的上下文。</p>
      </div>
      <div class="field">
        <label for="requestsPerMinute">每分钟请求数</label>
        <input id="requestsPerMinute" type="number" min="1" max="600" step="1" value="8" required>
        <p class="hint">按渠道配额填写，默认 8 次。教学、教研和审查共用额度；额度不足时会排队等待。</p>
      </div>
      <div class="field">
        <label for="researchMinutes">教研执行时限（分钟）</label>
        <input id="researchMinutes" type="number" min="1" max="30" step="1" value="8" required>
        <p class="hint">约束实际模型请求、搜索和抓取；额度排队与恢复等待另计，单回合最多等待 30 分钟。独立内容审查另计时，达到上限保留已保存进度。</p>
      </div>
    </details>`

  // 挂载设置表单到任意容器；返回 { reload, destroy }。
  S.mount = function (root, options = {}) {
    const onSaved = options.onSaved ?? (() => {})
    root.innerHTML = `
      <form class="settings-form">
        <fieldset class="settings-fields" disabled>
          ${FIELDS}
          <div class="actions"><button type="submit" class="settings-save">保存设置</button><span class="saved settings-saved"></span></div>
        </fieldset>
        <div class="settings-message" role="status" aria-live="polite"></div>
      </form>`

    const $ = (id) => root.querySelector(`#${id}`)
    const fields = root.querySelector('.settings-fields')
    const message = root.querySelector('.settings-message')
    const saved = root.querySelector('.settings-saved')
    let current = null

    function show(text, error = false) {
      message.textContent = text
      message.className = `settings-message ${error ? 'error' : 'success'}`
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

    function updateSearchHint() {
      if (!current) return
      let nextUrl = $('searchMcpUrl').value.trim().replace(/\/+$/, '')
      try { nextUrl = new URL(nextUrl).toString().replace(/\/+$/, '') } catch { /* 输入中，保存时校验 */ }
      let previousUrl = current.searchMcpUrl
      try { previousUrl = new URL(previousUrl).toString().replace(/\/+$/, '') } catch { /* 尚未配置 */ }
      const changed = nextUrl !== previousUrl
      $('searchKeyState').hidden = changed || !current.searchTokenSet
      $('searchToken').placeholder = changed ? '填写新搜索服务的 Token'
        : current.searchTokenSet ? '留空继续使用已配置的 Token' : '填写该搜索服务的 Token（如 th-…）'
      $('searchKeyHint').textContent = changed
        ? '搜索服务地址已修改，请填写新服务的 Token；留空表示不修改搜索配置。'
        : current.searchTokenSet ? '已配置搜索 Token；留空继续使用，输入新值可更换。保存后在下一回合生效。'
          : 'Tavily Hikari 使用 th- 开头的访问令牌；密钥保存在本机，保存后不会回显。'
    }

    function populate(config) {
      current = config
      $('baseUrl').value = config.baseUrl
      $('model').value = config.model
      $('thinking').value = config.thinking
      $('contextWindow').value = config.contextWindow
      $('requestsPerMinute').value = config.requestsPerMinute ?? 8
      $('researchMinutes').value = (config.researchDeadlineMs ?? 480000) / 60000
      $('apiKey').value = ''
      $('apiKey').placeholder = config.apiKeySet ? '留空继续使用已配置的密钥' : '填写该渠道的 API Key'
      $('keyState').hidden = !config.apiKeySet
      $('searchMcpUrl').value = config.searchMcpUrl ?? ''
      $('searchToken').value = ''
      $('searchToken').placeholder = config.searchTokenSet ? '留空继续使用已配置的 Token' : '填写该搜索服务的 Token（如 th-…）'
      $('searchKeyState').hidden = !config.searchTokenSet
      saved.textContent = config.updatedAt ? `上次保存：${new Date(config.updatedAt).toLocaleString()}` : config.configured ? '已读取当前服务配置' : '请先配置模型服务'
      updateKeyHint()
      updateSearchHint()
    }

    async function request(init) {
      const response = await fetch('/api/model-config', { ...init, signal: AbortSignal.timeout(10000) })
      if (response.status === 404) throw new Error('后台版本尚不支持网页设置，请重启 tutor 服务后刷新页面')
      let result
      try { result = await response.json() } catch { throw new Error('无法读取后台响应，请重启 tutor 服务后刷新页面') }
      if (!response.ok || result.ok !== true) throw new Error(result.error || '模型设置请求失败')
      return result
    }

    async function reload() {
      try {
        const result = await request()
        populate(result.config)
        fields.disabled = false
        return result
      } catch (error) {
        show(error.message, true)
        throw error
      }
    }

    $('baseUrl').addEventListener('input', updateKeyHint)
    $('searchMcpUrl').addEventListener('input', updateSearchHint)
    root.querySelector('.settings-form').addEventListener('submit', async (event) => {
      event.preventDefault()
      const config = {
        baseUrl: $('baseUrl').value.trim(), model: $('model').value.trim(), apiKey: $('apiKey').value.trim(),
        thinking: $('thinking').value, contextWindow: Number($('contextWindow').value), requestsPerMinute: Number($('requestsPerMinute').value),
        researchDeadlineMs: Number($('researchMinutes').value) * 60000,
        searchMcpUrl: $('searchMcpUrl').value.trim(), searchToken: $('searchToken').value.trim(),
      }
      fields.disabled = true
      root.querySelector('.settings-save').textContent = '保存中…'
      try {
        const result = await request({
          method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(config),
        })
        populate(result.config)
        show(result.flows?.length
          ? `已保存。进行中的 ${result.flows.length} 个流程将在下一回合使用新配置；本回合已发出的请求不受影响。`
          : '已保存。新开始的教学流程将使用此配置，无需重启服务。')
        onSaved(result)
      } catch (error) {
        show(error.message, true)
      } finally {
        fields.disabled = false
        root.querySelector('.settings-save').textContent = '保存设置'
      }
    })

    const ready = reload().catch(() => {})
    return { ready, reload, destroy() { root.innerHTML = '' } }
  }
})()
