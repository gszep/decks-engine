import assert from "node:assert/strict";
import test from "node:test";
import { createAuthenticator } from "../engine/auth.mjs";

test("local authentication supplies human and agent development identities", async () => {
  const auth = await createAuthenticator({ local: true, publicOrigin: "", defaultName: "designer" });
  const identity = await auth.browserPrincipal({ headers: {} }, {}, new URL("http://localhost/?user=Alice%40example.com"));
  assert.equal(identity.email, "alice@example.com");
  assert.equal((await auth.bearerPrincipal({ headers: { authorization: "Bearer local:Alice" } })).delegatedPrincipalId, "local:alice");
});

test("IAP identifies humans and the agents they sign in", async () => {
  const previous = process.env.DECKS_IAP_ENABLED;
  process.env.DECKS_IAP_ENABLED = "true";
  try {
    const auth = await createAuthenticator({ local: false, publicOrigin: "https://decks.example.com" });
    const human = auth.principal({ headers: {
      "x-goog-authenticated-user-email": "accounts.google.com:owner@example.com",
      "x-goog-authenticated-user-id": "accounts.google.com:human-1",
    } });
    assert.equal(human.type, "human");
    assert.equal(auth.principal({ headers: {
      "x-goog-authenticated-user-email": "accounts.google.com:decks-agent@example.iam.gserviceaccount.com",
      "x-goog-authenticated-user-id": "accounts.google.com:agent-1",
    } }), null, "service accounts are not principals");
    const delegated = await auth.bearerPrincipal({ headers: {
      "x-goog-authenticated-user-email": "accounts.google.com:owner@example.com",
      "x-goog-authenticated-user-id": "accounts.google.com:human-1",
      "x-decks-agent-client": "desktop-client.apps.googleusercontent.com",
    } });
    assert.equal(delegated.type, "agent");
    assert.equal(delegated.clientId, "desktop-client.apps.googleusercontent.com");
    assert.equal(delegated.delegatedPrincipalId, "iap-human:human-1");
  } finally {
    if (previous === undefined) delete process.env.DECKS_IAP_ENABLED;
    else process.env.DECKS_IAP_ENABLED = previous;
  }
});

test("public view-only mode starts without identity configuration", async () => {
  const previous = process.env.DECKS_PUBLIC_VIEW_ONLY;
  process.env.DECKS_PUBLIC_VIEW_ONLY = "true";
  try {
    const auth = await createAuthenticator({ local: false, publicOrigin: "https://decks.example.com" });
    assert.equal(auth.configured, false);
  } finally {
    if (previous === undefined) delete process.env.DECKS_PUBLIC_VIEW_ONLY;
    else process.env.DECKS_PUBLIC_VIEW_ONLY = previous;
  }
});
