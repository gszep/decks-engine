import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createAccessController } from "../engine/access.mjs";

const human = (email) => ({ id: `google|${email}`, email, name: email, type: "human" });

test("document ACL is deny-by-default and role grants are scoped", () => {
  const root = mkdtempSync(path.join(tmpdir(), "decks-access-"));
  try {
    const access = createAccessController({ file: path.join(root, "access.json"), documentId: "doc-123456789", bootstrapOwner: "owner@example.com" });
    const owner = human("owner@example.com"), editor = human("editor@example.com"), outsider = human("other@example.net");
    assert.equal(access.role(outsider), null);
    assert.equal(access.role(owner), "owner");
    access.remember(editor);
    access.grant(owner, { type: "user", email: editor.email, role: "editor" });
    assert.equal(access.requireEdit(editor), "editor");
    const signedIn = (person) => ({ id: `iap-agent:cli:${person.id}`, email: person.email, clientId: "cli", delegatedPrincipalId: person.id, type: "agent" });
    assert.equal(access.requireEdit(signedIn(editor)), "editor");
    assert.equal(access.role(signedIn(owner)), "editor", "agents never inherit ownership");
    assert.equal(access.role(signedIn(outsider)), null);
    assert.equal(access.role({ id: "sa", email: "sa@x.iam.gserviceaccount.com", clientId: "sa", type: "agent" }), null);
    assert.throws(() => access.requireOwner(editor), /insufficient/);
    assert.throws(() => access.requireView(outsider), /denied/);
    access.grant(owner, { type: "domain", domain: "example.net", role: "viewer" });
    assert.equal(access.requireView(outsider), "viewer");
    assert.throws(() => access.requireEdit(outsider), /insufficient/);
    const permission = access.list(owner).permissions.find((entry) => entry.principal.email === editor.email);
    access.revoke(owner, permission.id);
    assert.equal(access.role(editor), null);
    const privateAccess = createAccessController({
      file: path.join(root, "private-access.json"), documentId: "private-doc-123", bootstrapOwner: owner.email, privateOnly: true,
    });
    assert.equal(privateAccess.role(owner), "owner");
    assert.throws(() => privateAccess.grant(owner, { type: "anyone", role: "viewer" }), /individual user/);
    assert.throws(() => privateAccess.grant(owner, { type: "domain", domain: "example.com", role: "viewer" }), /individual user/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
