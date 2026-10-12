# Privacy

How YPad handles your data, in plain language.

## Two kinds of pads

| | Password-protected | Plain (no password) |
|---|---|---|
| Server sees | Ciphertext only | Full content |
| Anyone with link needs | Link **+ password** | Just the link |
| Operator can read it | No (only metadata: pad exists, rough size, IPs, timing) | Yes |
| If password is lost | Data is unrecoverable | N/A |

## Password-protected pads

- The password is entered in your browser and **never sent to the server**.
  A key is derived locally (PBKDF2-SHA-256, 250k iterations, salted with the
  pad id) and content is encrypted with AES-GCM before it leaves your device.
- The server relays and stores only ciphertext. It cannot read your text,
  spreadsheet cells, or language setting.
- Password choice is your responsibility: the ciphertext is stored on the
  server, so a weak password could be guessed offline by anyone who obtains
  it — same as any password-based encryption. Use a long, unique passphrase.
- Share the link and the password through **different channels**.
- Setting a password on a pad that already had content does not retroactively
  protect what the server already saw — it encrypts everything from that
  moment on.
- No recovery: lose the password and the pad is gone. Pads expire
  automatically 24h after the last client disconnects.

## Plain pads

- Same as before: anyone with the link can read and edit, and the server
  operator can read everything. Do not paste secrets, credentials, private
  keys, or personal data into a pad without a password.
- The app badges these `Not encrypted`.

## What the operator still sees (both kinds)

Pad ids, connection IPs/timing, rough encrypted sizes, and the fact that a
pad exists. Expiry deletes all stored data (`deleteAll` on a 24h alarm).

## Self-hosting

The hosted instance is a convenience. For full control, fork the repo and run
your own sync worker (`npm run server:deploy`) plus any static host — then
you are the operator. See [README](./README.md#deploy).
