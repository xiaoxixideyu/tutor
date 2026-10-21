// 共享 JSON-RPC 客户端：所有页面统一错误处理与请求格式。
(function () {
  async function rpc(method, params) {
    const response = await fetch('/rpc', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params }),
    })
    const body = await response.json()
    if (body.error) throw new Error(body.error.message)
    return body.result
  }

  window.TutorRpc = rpc
})()
