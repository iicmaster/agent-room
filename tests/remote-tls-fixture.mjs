import https from 'node:https'
import http from 'node:http'
import { once } from 'node:events'


// Shared trusted test TLS material for Remote Mode CLI/MCP integration tests.
const TEST_CA_CERT = `-----BEGIN CERTIFICATE-----
MIIBojCCAUmgAwIBAgIURBT044gJgrco3hkSvJsra2Toq5wwCgYIKoZIzj0EAwIw
JzElMCMGA1UEAwwcYWdlbnQtcm9vbSBlcGhlbWVyYWwgdGVzdCBDQTAeFw0yNjEx
MDExNDQxNThaFw0yNzExMDExNDQxNThaMCcxJTAjBgNVBAMMHGFnZW50LXJvb20g
ZXBoZW1lcmFsIHRlc3QgQ0EwWTATBgcqhkjOPQIBBggqhkjOPQMBBwNCAAQA4mH+
MhmHwt6e/QWIt13zUCZuxqmzuUOvHiN9dys2GX/eeMoVIzmQW5hUPx/6iluc2mKM
Incs/Hy+ZHi2l4ugo1MwUTAdBgNVHQ4EFgQUbtQePCCYfsGgFXc7CtX5sgn4Rm0w
HwYDVR0jBBgwFoAUbtQePCCYfsGgFXc7CtX5sgn4Rm0wDwYDVR0TAQH/BAUwAwEB
/zAKBggqhkjOPQQDAgNHADBEAiBnp7OgFpcewgS0G6OrHb+zL4ucBiCWSV6sVOAY
j90MTgIgJRWgatQGDYqs8Ise2N6+1ZDDjHGpPpHvh3RVhO2RqE0=
-----END CERTIFICATE-----\n`
const TEST_LEAF_CERT = `-----BEGIN CERTIFICATE-----
MIIBbzCCARagAwIBAgIUEC33KAbkYhFWtADAdoH4wja5vnQwCgYIKoZIzj0EAwIw
JzElMCMGA1UEAwwcYWdlbnQtcm9vbSBlcGhlbWVyYWwgdGVzdCBDQTAeFw0yNjEx
MDExNDQxNThaFw0yNzExMDExNDQxNThaMBQxEjAQBgNVBAMMCWxvY2FsaG9zdDBZ
MBMGByqGSM49AgEGCCqGSM49AwEHA0IABBqP/Y9C3SRvxeILGCrljd7fiLSigGxs
woZT4nrIht2sD8zevlrB1X4JpqjhRzb5yqmBdOzIYq1fsOfJ9XXQHzCjMzAxMBoG
A1UdEQQTMBGHBH8AAAGCCWxvY2FsaG9zdDATBgNVHSUEDDAKBggrBgEFBQcDATAK
BggqhkjOPQQDAgNHADBEAiAhbjMmm6CJwZ2UnUI8YqzFupgJgrQ+oDhL64xW1FyE
kAIgE9tTd2NOoL5eAq2b6ANbM2vFrPwwJZdjHajtso45vQo=
-----END CERTIFICATE-----\n`
const TEST_LEAF_KEY = `-----BEGIN EC PRIVATE KEY-----
MHcCAQEEIJwqrCZhQNSY5RcL0pHqQQ/LMmHfcRXkAh8kVubm34HHoAoGCCqGSM49
AwEHoUQDQgAEGo/9j0LdJG/F4gsYKuWN3t+ItKKAbGzChlPiesiG3awPzN6+WsHV
fgmmqOFHNvnKqYF07MhirV+w58n1ddAfMA==
-----END EC PRIVATE KEY-----\n`
export { TEST_CA_CERT, TEST_LEAF_CERT, TEST_LEAF_KEY }
export async function startTrustedTlsFront(t, initialBackendPort = null) {
  let backendPort = initialBackendPort
  const server = https.createServer({ cert: TEST_LEAF_CERT, key: TEST_LEAF_KEY }, (req, res) => {
    const chunks = []
    req.on('data', chunk => chunks.push(chunk))
    req.on('end', () => {
      const body = Buffer.concat(chunks)
      const headers = { ...req.headers }
      for (const name of ['connection','keep-alive','transfer-encoding','te','trailer','upgrade','proxy-authenticate','proxy-authorization']) delete headers[name]
      headers['content-length'] = body.length
      const upstream = http.request({ host:'127.0.0.1', port:backendPort, path:req.url, method:req.method, headers, agent:false }, response => {
        const outHeaders = { ...response.headers }
        for (const name of ['connection','keep-alive','transfer-encoding','te','trailer','upgrade','proxy-authenticate','proxy-authorization']) delete outHeaders[name]
        res.writeHead(response.statusCode ?? 502, outHeaders)
        response.pipe(res)
      })
      upstream.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end() })
      if (body.length) upstream.write(body)
      upstream.end()
    })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => new Promise(resolve => server.close(() => resolve())))
  return {
    origin: `https://127.0.0.1:${server.address().port}`,
    setBackend(port) { backendPort = port },
  }
}
