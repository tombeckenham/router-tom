---
'@tanstack/start-server-core': minor
'@tanstack/start-plugin-core': minor
'@tanstack/router-core': patch
---

perf(start): dispatch server-only routes without constructing a Router. The Start plugin builds a server-only route tree, and `createStartHandler` matches exact server-route requests against it before touching the router entry, which now loads lazily. Apps whose root route defines `server` options, or where a server-only param route would shadow a page, keep the Router path with a build warning.
