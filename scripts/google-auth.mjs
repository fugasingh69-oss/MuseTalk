// One-time local helper: connects YOUR Google account and prints a refresh token.
// Run:  npm run google-auth
// It opens a local page on http://localhost:53682 — sign in with the Google account
// whose Drive should hold the MuseTalk archive, click Allow, and copy the printed
// GOOGLE_REFRESH_TOKEN into Netlify's environment variables (server-side only).
// Scopes: drive.file ONLY — the app can see/touch only files it creates. Nothing is shared.
import http from 'node:http'
import { exec } from 'node:child_process'

const clientId = process.env.GOOGLE_CLIENT_ID
const clientSecret = process.env.GOOGLE_CLIENT_SECRET
if (!clientId || !clientSecret) {
  console.error('\nSet GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET first (see README step 2).\n' +
    'Example (PowerShell):  $env:GOOGLE_CLIENT_ID="..."; $env:GOOGLE_CLIENT_SECRET="..."; npm run google-auth\n' +
    'Example (Mac/Linux):   GOOGLE_CLIENT_ID=... GOOGLE_CLIENT_SECRET=... npm run google-auth\n')
  process.exit(1)
}

const PORT = 53682
const REDIRECT = `http://localhost:${PORT}/oauth`
const authUrl = 'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams({
  client_id: clientId, redirect_uri: REDIRECT, response_type: 'code',
  scope: 'https://www.googleapis.com/auth/drive.file',
  access_type: 'offline', prompt: 'consent',
})

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, REDIRECT)
  if (url.pathname !== '/oauth') { res.writeHead(404); return res.end() }
  const code = url.searchParams.get('code')
  if (!code) { res.writeHead(400); return res.end('No code received. Please try again.') }
  try {
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ code, client_id: clientId, client_secret: clientSecret, redirect_uri: REDIRECT, grant_type: 'authorization_code' }),
    })
    const data = await tokenRes.json()
    if (!data.refresh_token) throw new Error('No refresh token returned. Remove MuseTalk access at myaccount.google.com/permissions and run this again.')
    console.log('\n================ COPY THIS INTO NETLIFY (server-side only) ================')
    console.log(`GOOGLE_REFRESH_TOKEN=${data.refresh_token}`)
    console.log('===========================================================================\n')
    res.end('<h2>Done! Copy the refresh token from your terminal into Netlify, then close this tab.</h2>')
  } catch (e) {
    console.error(e)
    res.writeHead(500); res.end('Token exchange failed — check the terminal output.')
  } finally {
    setTimeout(() => server.close(), 500)
  }
})

server.listen(PORT, () => {
  console.log(`\nOpen this URL in your browser and sign in with YOUR Google account:\n\n${authUrl}\n`)
  const opener = process.platform === 'win32' ? 'start' : process.platform === 'darwin' ? 'open' : 'xdg-open'
  exec(`${opener} "${authUrl}"`, () => {})
})
