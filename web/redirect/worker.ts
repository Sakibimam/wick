// The product's first worker name. Every path moves to the wick worker, keeping path and query.
export default {
  fetch(req: Request) {
    const u = new URL(req.url);
    return Response.redirect(`https://wick.earn-shield-alerts.workers.dev${u.pathname}${u.search}`, 301);
  },
};
