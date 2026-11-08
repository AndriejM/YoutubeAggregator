// Service worker: no subscription sources available from here — youtubei
// requires the page's SAPISIDHASH auth header, so all catalog reads go through
// the page bridge (PLAN.md §6, §7). Stage 3 will use the worker for RSS
// /feeds/videos.xml, which is auth-free (PLAN.md §10).
