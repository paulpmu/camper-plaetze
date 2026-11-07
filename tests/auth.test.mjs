// Tests der Anmeldeprüfung (server/auth.js) mit selbst erzeugten Schlüsseln: node --test tests/auth.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { angemeldet } from "../server/auth.js";

const ISS = "https://paulpmu.cloudflareaccess.com";
const AUD = "aud-tag-123";
const env = { ACCESS_AUD: AUD };

const { privateKey, publicKey } = await crypto.subtle.generateKey(
  { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
const fremd = await crypto.subtle.generateKey(
  { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
const jwk = { ...(await crypto.subtle.exportKey("jwk", publicKey)), kid: "k1" };

let abrufe = [];
globalThis.fetch = async (url) => { abrufe.push(url); return new Response(JSON.stringify({ keys: [jwk] })); };

const b64 = (o) => Buffer.from(typeof o === "string" ? o : JSON.stringify(o)).toString("base64url");
async function jwt(claims, { key = privateKey, kid = "k1", alg = "RS256" } = {}) {
  const now = Math.floor(Date.now() / 1000);
  const h = b64({ alg, kid, typ: "JWT" }), p = b64({ iss: ISS, aud: [AUD], email: "Paul@Test.ch", exp: now + 3600, iat: now, ...claims });
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(`${h}.${p}`));
  return `${h}.${p}.${Buffer.from(sig).toString("base64url")}`;
}
const req = (token, host = "camper-planer.pages.dev") =>
  new Request(`https://${host}/api/ich`, { headers: token ? { "Cf-Access-Jwt-Assertion": token } : {} });

test("gültiges Token ergibt die E-Mail-Adresse in Kleinbuchstaben", async () => {
  assert.equal(await angemeldet(req(await jwt({})), env), "paul@test.ch");
  assert.ok(abrufe[0].startsWith(ISS + "/cdn-cgi/access/certs"));
});
test("ohne Token: nicht angemeldet", async () => {
  assert.equal(await angemeldet(req(null), env), null);
});
test("falsche Anwendung (aud) wird abgelehnt", async () => {
  assert.equal(await angemeldet(req(await jwt({ aud: ["andere-app"] })), env), null);
});
test("abgelaufenes Token wird abgelehnt", async () => {
  assert.equal(await angemeldet(req(await jwt({ exp: Math.floor(Date.now() / 1000) - 600 })), env), null);
});
test("fremder Aussteller wird abgelehnt, auch mit passender Signatur", async () => {
  assert.equal(await angemeldet(req(await jwt({ iss: "https://boese.example.com" })), env), null);
});
test("mit ACCESS_TEAM gesetzt: nur dieses Team", async () => {
  assert.equal(await angemeldet(req(await jwt({ iss: "https://anderes.cloudflareaccess.com" })), { ...env, ACCESS_TEAM: ISS }), null);
});
test("falsche Signatur wird abgelehnt", async () => {
  assert.equal(await angemeldet(req(await jwt({}, { key: fremd.privateKey })), env), null);
});
test("veränderte E-Mail-Adresse macht die Signatur ungültig", async () => {
  const [h, , s] = (await jwt({})).split(".");
  const p = b64({ iss: ISS, aud: [AUD], email: "boese@test.ch", exp: Math.floor(Date.now() / 1000) + 3600 });
  assert.equal(await angemeldet(req(`${h}.${p}.${s}`), env), null);
});
test("alg none wird abgelehnt", async () => {
  const h = b64({ alg: "none", kid: "k1" }), p = b64({ iss: ISS, aud: [AUD], email: "x@y.ch", exp: Math.floor(Date.now() / 1000) + 3600 });
  assert.equal(await angemeldet(req(`${h}.${p}.x`), env), null);
});
test("Testzugang DEV_EMAIL gilt nur auf localhost", async () => {
  assert.equal(await angemeldet(req(null, "camper-planer.pages.dev"), { ...env, DEV_EMAIL: "dev@test.ch" }), null);
  assert.equal(await angemeldet(req(null, "localhost"), { ...env, DEV_EMAIL: "dev@test.ch" }), "dev@test.ch");
});
test("ohne ACCESS_AUD wird kein Token akzeptiert", async () => {
  await assert.rejects(angemeldet(req(await jwt({})), {}));
});
