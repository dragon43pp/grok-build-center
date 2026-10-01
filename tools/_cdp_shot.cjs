const fs = require('fs')
const ws = require('ws')
const port = 9367
async function main() {
  const list = await (await fetch('http://127.0.0.1:' + port + '/json')).json()
  const target = list.find(t => t.type === 'page' && !t.url.startsWith('devtools://'))
  if (!target) throw new Error('no page')
  const sock = new ws.WebSocket(target.webSocketDebuggerUrl)
  await new Promise(r => sock.on('open', r))
  let id = 1
  function send(method, params) {
    return new Promise(r => {
      const myId = id++
      sock.send(JSON.stringify({ id: myId, method, params }))
      sock.on('message', function h(m) {
        const d = JSON.parse(m)
        if (d.id === myId) { sock.off('message', h); r(d.result) }
      })
    })
  }
  const r = await send('Page.captureScreenshot', { format: 'png' })
  fs.writeFileSync('D:/grok-build-center-desktop/tools/_screenshot_theme.png', Buffer.from(r.data, 'base64'))
  console.log('saved')
  sock.close()
}
main().catch(e => { console.error(e.message); process.exit(1) })