# Lattice dashboard

A web page for running Lattice nodes: chain health, logs, mining, storage,
settings, tokens, restart and wipe. It is a client of a node's operator API.
It is three static files (`index.html`, `dashboard.js`, `dashboard.css`) with
no dependencies and no build step. The node does not serve it.

## Run it

Serve the directory from any static host, or locally:

```sh
python3 -m http.server 8099 --bind 127.0.0.1
```

Then open <http://127.0.0.1:8099/>. Opening `index.html` as a `file://` URL
does not work: browsers give such a page no origin a node can allow.

## Point it at a node

The first screen asks for a node address and a token.

- **Remote operator listener** (`operatorListen`): the address is the
  listener's URL (for example `http://10.0.0.6:8090`). The token comes from
  `lattice tokens create dashboard --role admin --root <root>`. A `read`
  token gets a read-only page. A token limited to certain routes gets
  only the writes those routes allow.
- **Loopback RPC port** (a node on this machine): the address is
  `http://127.0.0.1:<rpc port>` (8080 by default). The token is the node's
  cookie, from `cat <root>/chains/Nexus/.cookie`. The cookie changes
  every time the node restarts.

The node must also allow the page's origin, exactly as the browser shows it
(for example `http://127.0.0.1:8099`):

- for the operator listener, add it to `operatorAllowedOrigins` in
  `lattice.json`;
- for the loopback port, add it to `rpcAllowedOrigins`.

Then restart the node. Without the listing, the browser blocks every
request and the page reports that the node refused it.

You can add more nodes under **All nodes**. Each one is reached by its own
URL and token.

## Security

- Tokens stay in the tab's session storage unless you tick
  "Remember on this device" for that node. A remembered token goes into this
  origin's local storage. Host the page on an origin that serves nothing
  else.
- A token is only sent to its own node, in an `Authorization` header. It
  is never put in a URL.
- Reach nodes over a private network or TLS. On plain HTTP over an open
  network, anyone on the path can read the token.
- `index.html` carries a strict Content-Security-Policy (scripts and styles
  only from the page's own origin, nothing inline) and `no-referrer`. A
  `<meta>` policy cannot forbid framing, so a host that can set headers
  should also send `Content-Security-Policy: frame-ancestors 'none'`.
- **Sign out of all nodes** deletes every token, snapshot and setting
  the page stored.

## What it uses from the node

The page uses the operator API (`/status`, `/health`, `/hosted-chains`,
`/config`, `/mining`, `/logs`, `/disk`, `/metrics`, `/tokens`, `/pins`,
`/restart`, `/wipe`) and the read API (`/api/...`). Older nodes may lack
some newer routes, and the page works around each one:

- **`GET /whoami`**: without it, every write is offered and the node's
  refusal explains each one.
- **`version` / `startedAt` in `/status`**: without them, the version is
  not shown, and uptime and restart detection use `/metrics`.
- **No start time from either route**: a restart counts as done once the
  node has been seen down and then answers again.
