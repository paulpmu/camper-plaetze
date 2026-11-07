// Prüft die Anmeldung von Cloudflare Access (signiertes JWT im Header Cf-Access-Jwt-Assertion).
// Access lässt ohnehin nur freigegebene Personen durch; die Prüfung hier stellt zusätzlich sicher,
// dass niemand an Access vorbei eine fremde E-Mail-Adresse vortäuschen kann.

const TEAM = /^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com$/;
const keyCache = new Map(); // Aussteller → { zeit, keys }

function b64urlBytes(s) {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
}
const b64urlJson = (s) => JSON.parse(new TextDecoder().decode(b64urlBytes(s)));

async function keys(iss) {
  const hit = keyCache.get(iss);
  if (hit && Date.now() - hit.zeit < 3600_000) return hit.keys;
  const r = await fetch(`${iss}/cdn-cgi/access/certs`);
  if (!r.ok) throw new Error("Zertifikate von Cloudflare Access nicht abrufbar");
  const { keys: list } = await r.json();
  const out = {};
  for (const jwk of list) {
    out[jwk.kid] = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  }
  keyCache.set(iss, { zeit: Date.now(), keys: out });
  return out;
}

// Gibt die E-Mail-Adresse der angemeldeten Person zurück oder null
export async function angemeldet(request, env) {
  const token = request.headers.get("Cf-Access-Jwt-Assertion");
  if (!token) {
    // Nur für lokale Tests (wrangler pages dev mit .dev.vars); in Produktion ist DEV_EMAIL nie gesetzt
    if (env.DEV_EMAIL && new URL(request.url).hostname === "localhost") return env.DEV_EMAIL.toLowerCase();
    return null;
  }
  if (!env.ACCESS_AUD) throw new Error("ACCESS_AUD fehlt");
  const [h, p, s] = token.split(".");
  if (!s) return null;
  const head = b64urlJson(h), claims = b64urlJson(p);
  if (head.alg !== "RS256" || !TEAM.test(claims.iss || "")) return null;
  if (env.ACCESS_TEAM && claims.iss !== env.ACCESS_TEAM) return null;
  const aud = [].concat(claims.aud || []);
  if (!aud.includes(env.ACCESS_AUD)) return null;
  const now = Date.now() / 1000;
  if (!claims.exp || claims.exp < now - 60 || (claims.nbf && claims.nbf > now + 60)) return null;
  let key = (await keys(claims.iss))[head.kid];
  if (!key) { keyCache.delete(claims.iss); key = (await keys(claims.iss))[head.kid]; }
  if (!key) return null;
  const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64urlBytes(s), new TextEncoder().encode(`${h}.${p}`));
  return ok && claims.email ? String(claims.email).toLowerCase() : null;
}
