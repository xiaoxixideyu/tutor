;(function () {
  const levels = [
    ['default', '渠道默认'],
    ['off', '关闭'],
    ['minimal', '极低'],
    ['low', '轻量'],
    ['medium', '适中'],
    ['high', '深入'],
    ['max', '最高'],
  ]
  const esc = (value) => window.TutorDom.esc(value)
  function field(name, label, type = 'text', hint = '') {
    return (
      '<div class="field"><label for="cfg-' +
      name +
      '">' +
      label +
      '</label><input id="cfg-' +
      name +
      '" name="' +
      name +
      '" type="' +
      type +
      '" autocomplete="' +
      (type === 'password' ? 'new-password' : 'off') +
      '"><p class="hint">' +
      hint +
      '</p></div>'
    )
  }
  function reasoning(name, label, hint) {
    return (
      '<div class="field"><label for="cfg-' +
      name +
      '">' +
      label +
      '</label><select id="cfg-' +
      name +
      '" name="' +
      name +
      '">' +
      levels.map(([value, title]) => '<option value="' + value + '">' + title + '</option>').join('') +
      '</select><p class="hint">' +
      hint +
      '</p></div>'
    )
  }
  window.TutorSettings = {
    mount(root, options = {}) {
      root.innerHTML =
        '<form class="settings-form"><fieldset>' +
        field('baseUrl', '服务地址', 'url', '填写渠道基础地址，例如 https://api.example.com/v1。') +
        field('model', '模型名称', 'text', '使用渠道提供的模型名称。') +
        field('apiKey', 'API Key', 'password', '密钥保存在本机，留空可沿用当前渠道的密钥。') +
        reasoning('agentThinking', '教学推理', '轻量适合日常问答；深入推理可能需要更长等待。') +
        reasoning('reviewThinking', '内容核验推理', '用于独立解题、内容核对和主观题评阅。') +
        '<details class="judgment-settings"><summary>判断模型（可选）</summary><div class="field"><label for="cfg-judgmentProvider">判断方式</label><select id="cfg-judgmentProvider" name="judgmentProvider"><option value="llm">大模型判断（默认）</option><option value="typesafe">TypeSafe / Jev 辅助判断</option></select><p class="hint">默认沿用大模型。启用辅助判断后，不确定或服务失败时自动使用核验大模型。</p></div>' +
        field(
          'reviewModel',
          '核验大模型（可选）',
          'text',
          '可指定当前服务渠道中的其他模型；留空沿用主模型。',
        ) +
        '<div class="typesafe-fields" hidden>' +
        field(
          'judgmentBaseUrl',
          '快速判断服务地址',
          'url',
          'TypeSafe 默认使用 https://api.typesafe.ai/v1。',
        ) +
        field('judgmentModel', '快速判断模型', 'text', '默认 jev-latest，也可填写该服务提供的模型名称。') +
        field(
          'judgmentApiKey',
          '快速判断 API Key',
          'password',
          '密钥单独保存在本机；同一服务地址下留空可沿用。',
        ) +
        '<details><summary>判断与等待设置</summary>' +
        field('judgmentConfidence', '最低判断置信度（%）', 'number', '低于此值交给大模型复核，默认 95%。') +
        field(
          'judgmentSeconds',
          '快速判断等待上限（秒）',
          'number',
          '包括排队等待；超时自动改用大模型，默认 5 秒。',
        ) +
        field('judgmentRequestsPerMinute', '快速判断每分钟请求数', 'number') +
        '</details><button type="button" class="secondary settings-judge-test">测试快速判断连接</button></div>' +
        '<p class="hint">辅助判断用于画像依据核对与内容范围预检；内容正确性、解题和评分反馈仍由大模型处理。</p></details>' +
        '<details><summary>连接与请求设置</summary>' +
        reasoning('thinking', '连接测试推理', '用于模型连通测试。') +
        field('contextWindow', '上下文长度', 'number') +
        field('maxOutputTokens', '最大输出上限', 'number', '具体教学任务会按需要进一步收紧输出。') +
        field('requestsPerMinute', '每分钟请求数', 'number') +
        field('researchMinutes', '单次联网处理时限（分钟）', 'number') +
        '</details>' +
        '<details><summary>联网资料搜索</summary><div class="field"><label for="cfg-searchProvider">搜索服务</label><select id="cfg-searchProvider" name="searchProvider"><option value="exa">Exa</option><option value="tavily">Tavily Hikari</option><option value="custom">自定义 MCP</option></select></div>' +
        field(
          'searchMcpUrl',
          '搜索服务地址',
          'url',
          'Exa 使用 https://mcp.exa.ai/mcp；也可填写兼容 MCP 服务。',
        ) +
        field('searchToken', '搜索服务密钥', 'password', '留空沿用已有密钥；更换地址需要新密钥。') +
        '</details>' +
        '<p class="settings-saved"></p><div class="settings-buttons"><button type="submit" class="primary settings-save">保存设置</button><button type="button" class="secondary settings-test">测试连接</button></div></fieldset><div class="settings-status" role="status"></div></form>'
      const form = root.querySelector('form'),
        fieldset = root.querySelector('fieldset'),
        status = root.querySelector('.settings-status')
      const input = (name) => root.querySelector('[name="' + name + '"]')
      let current = null,
        destroyed = false
      function show(message, error = false) {
        status.textContent = message
        status.classList.toggle('error', error)
      }
      function judgmentMode() {
        const enabled = input('judgmentProvider').value === 'typesafe'
        const fields = root.querySelector('.typesafe-fields')
        fields.hidden = !enabled
        fields.querySelectorAll('input, button').forEach((control) => {
          control.disabled = !enabled
        })
        input('judgmentBaseUrl').required = enabled
        input('judgmentModel').required = enabled
        input('judgmentApiKey').required = enabled && !current?.judgment?.apiKeySet
      }
      input('judgmentProvider').addEventListener('change', judgmentMode)
      for (const name of [
        'contextWindow',
        'maxOutputTokens',
        'requestsPerMinute',
        'researchMinutes',
        'judgmentConfidence',
        'judgmentRequestsPerMinute',
      ])
        input(name).step = '1'
      input('judgmentConfidence').min = '50'
      input('judgmentConfidence').max = '100'
      input('judgmentConfidence').step = 'any'
      input('judgmentSeconds').min = '0.5'
      input('judgmentSeconds').max = '60'
      input('judgmentSeconds').step = '0.001'
      input('judgmentRequestsPerMinute').min = '1'
      input('judgmentRequestsPerMinute').max = '600'
      input('baseUrl').required = true
      input('model').required = true
      input('contextWindow').min = '1024'
      input('contextWindow').max = '2000000'
      input('maxOutputTokens').min = '256'
      input('maxOutputTokens').max = '2000000'
      input('requestsPerMinute').min = '1'
      input('requestsPerMinute').max = '600'
      input('researchMinutes').min = '1'
      input('researchMinutes').max = '30'
      input('searchProvider').addEventListener('change', () => {
        if (input('searchProvider').value === 'exa') input('searchMcpUrl').value = 'https://mcp.exa.ai/mcp'
      })
      function populate(config) {
        current = config
        for (const name of [
          'baseUrl',
          'model',
          'thinking',
          'agentThinking',
          'reviewThinking',
          'reviewModel',
          'contextWindow',
          'maxOutputTokens',
          'requestsPerMinute',
          'searchMcpUrl',
        ]) {
          input(name).value =
            config[name] ?? (name === 'agentThinking' || name === 'reviewThinking' ? 'low' : '')
        }
        input('researchMinutes').value = String((config.researchDeadlineMs ?? 240000) / 60000)
        input('apiKey').value = ''
        input('apiKey').placeholder = config.apiKeySet ? '已配置，留空继续使用' : '填写 API Key'
        input('searchToken').value = ''
        input('searchToken').placeholder = config.searchTokenSet ? '已配置，留空继续使用' : '填写搜索密钥'
        const judgment = config.judgment ?? {}
        input('judgmentProvider').value = judgment.provider ?? 'llm'
        input('judgmentBaseUrl').value = judgment.baseUrl ?? 'https://api.typesafe.ai/v1'
        input('judgmentModel').value = judgment.model ?? 'jev-latest'
        input('judgmentApiKey').value = ''
        input('judgmentApiKey').placeholder = judgment.apiKeySet
          ? '已配置，留空继续使用'
          : '填写快速判断 API Key'
        input('judgmentConfidence').value = String((judgment.minimumConfidence ?? 0.95) * 100)
        input('judgmentSeconds').value = String((judgment.timeoutMs ?? 5000) / 1000)
        input('judgmentRequestsPerMinute').value = String(judgment.requestsPerMinute ?? 60)
        judgmentMode()
        input('searchProvider').value = (config.searchMcpUrl ?? '').includes('mcp.exa.ai')
          ? 'exa'
          : (config.searchMcpUrl ?? '').includes('tavily')
            ? 'tavily'
            : 'custom'
        root.querySelector('.settings-saved').textContent = config.configured
          ? '已读取当前连接设置'
          : '先配置模型，再开始学习。'
      }
      function payload() {
        return {
          baseUrl: input('baseUrl').value.trim(),
          model: input('model').value.trim(),
          apiKey: input('apiKey').value.trim(),
          thinking: input('thinking').value,
          agentThinking: input('agentThinking').value,
          reviewThinking: input('reviewThinking').value,
          reviewModel: input('reviewModel').value.trim(),
          judgment: {
            provider: input('judgmentProvider').value,
            baseUrl: input('judgmentBaseUrl').value.trim(),
            model: input('judgmentModel').value.trim(),
            apiKey: input('judgmentApiKey').value.trim(),
            minimumConfidence: Number(input('judgmentConfidence').value) / 100,
            timeoutMs: Math.round(Number(input('judgmentSeconds').value) * 1000),
            requestsPerMinute: Number(input('judgmentRequestsPerMinute').value),
          },
          contextWindow: Number(input('contextWindow').value),
          maxOutputTokens: Number(input('maxOutputTokens').value),
          requestsPerMinute: Number(input('requestsPerMinute').value),
          researchDeadlineMs: Number(input('researchMinutes').value) * 60000,
          searchMcpUrl: input('searchMcpUrl').value.trim(),
          searchToken: input('searchToken').value.trim(),
        }
      }
      async function request(url, body) {
        const response = await fetch(url, {
          method: body ? 'POST' : 'GET',
          headers: body ? { 'content-type': 'application/json' } : {},
          body: body ? JSON.stringify(body) : undefined,
          signal: AbortSignal.timeout(
            url.endsWith('judgment-test')
              ? Number(input('judgmentSeconds').value) * 1000 + 5000
              : url.endsWith('model-test')
                ? 120000
                : 10000,
          ),
        })
        const result = await response.json()
        if (!response.ok || result.ok === false)
          throw new Error(result.error?.message ?? result.error ?? '请求失败')
        return result
      }
      async function reload() {
        fieldset.disabled = true
        try {
          const result = await request('/api/model-config')
          if (!destroyed) populate(result.config)
          return result
        } catch (error) {
          if (!destroyed) show(error.message, true)
          throw error
        } finally {
          if (!destroyed) fieldset.disabled = false
        }
      }
      form.addEventListener('submit', async (event) => {
        event.preventDefault()
        fieldset.disabled = true
        show('正在保存…')
        try {
          const result = await request('/api/model-config', payload())
          populate(result.config)
          show('已保存，下一回合使用新的设置。')
          options.onSaved?.(result)
        } catch (error) {
          show(error.message, true)
        } finally {
          fieldset.disabled = false
        }
      })
      root.querySelector('.settings-test').addEventListener('click', async () => {
        fieldset.disabled = true
        show('正在测试连接…')
        try {
          const result = await request('/api/model-test', payload())
          show(
            '连接成功 · ' +
              result.model +
              ' · ' +
              Math.round(result.elapsedMs / 1000) +
              ' 秒' +
              (result.text ? ' · ' + result.text : ''),
          )
        } catch (error) {
          show(error.message, true)
        } finally {
          fieldset.disabled = false
        }
      })
      root.querySelector('.settings-judge-test').addEventListener('click', async () => {
        fieldset.disabled = true
        show('正在测试快速判断连接…')
        try {
          const result = await request('/api/judgment-test', payload())
          show(
            '快速判断服务已连通 · ' +
              result.model +
              ' · ' +
              (result.elapsedMs / 1000).toFixed(2) +
              ' 秒' +
              (result.choice === 'uncertain' ||
              result.confidence < Number(input('judgmentConfidence').value) / 100
                ? ' · 样例判断不确定，学习中会交给大模型复核'
                : ''),
          )
        } catch (error) {
          show(error.message, true)
        } finally {
          fieldset.disabled = false
        }
      })
      const ready = reload().catch(() => {})
      return {
        ready,
        reload,
        destroy() {
          destroyed = true
          root.innerHTML = ''
        },
      }
    },
  }
})()
