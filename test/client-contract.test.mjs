import assert from "node:assert/strict";
import test from "node:test";

const client = await import("../dist/index.js");

test("public API creates, uploads, inspects, downloads, and deletes against the production HTTP shape", async () => {
  const ciphertext = new Uint8Array([1, 2, 3]);
  const sha256 = await client.sha256Hex(ciphertext);
  const endpoint = "https://agentbox.link";
  const box = {
    boxId: "box-1",
    createdAt: "2026-08-04T00:00:00.000Z",
    expiresAt: "2026-08-05T00:00:00.000Z",
    upload: { capability: "write-value", url: `${endpoint}/v1/boxes/box-1` },
    download: { capability: "read-value", url: `${endpoint}/v1/boxes/box-1` },
    delete: { capability: "delete-value", url: `${endpoint}/v1/boxes/box-1` },
  };
  const requests = [];
  const fetch = async (input, init = {}) => {
    const request = new Request(input, init);
    requests.push(request);
    if (request.method === "POST") return Response.json({
      ...box,
      capability: "must-not-escape",
      paymentSignature: "must-not-escape",
      privateKey: "must-not-escape",
    }, { status: 201 });
    if (request.method === "PUT") return new Response(null, { status: 204 });
    if (request.method === "HEAD") return new Response(null, { headers: {
      "content-length": "3",
      "x-agentbox-created-at": box.createdAt,
      "x-agentbox-expires-at": box.expiresAt,
      "x-agentbox-sha256": sha256,
    } });
    if (request.method === "GET") return new Response(ciphertext, { headers: { "x-agentbox-sha256": sha256 } });
    if (request.method === "DELETE") return new Response(null, { status: 204 });
    throw new Error("unexpected request");
  };

  const created = await client.createAndUpload({
    ciphertext,
    endpoint,
    fetch,
    idempotencyKey: "stable-request",
    maxPriceAtomic: "10000",
    payerPrivateKey: `0x${"1".repeat(64)}`,
    paymentSignature: "saved-authorization",
  });
  assert.deepEqual(created, box);
  const capability = { boxId: box.boxId, capability: box.download.capability, endpoint, fetch, url: box.download.url };
  assert.deepEqual(await client.inspectBox(capability), {
    ciphertextSha256: sha256,
    ciphertextSize: 3,
    createdAt: box.createdAt,
    expiresAt: box.expiresAt,
  });
  assert.deepEqual(await client.downloadAndVerify({ ...capability, expectedSha256: sha256, expectedSize: 3 }), ciphertext);
  await client.deleteBox({ ...capability, capability: box.delete.capability });

  assert.deepEqual(requests.map(({ method }) => method), ["POST", "PUT", "HEAD", "GET", "DELETE"]);
  assert.equal(requests[0].headers.get("payment-signature"), "saved-authorization");
  assert.equal(requests[0].headers.get("content-type"), "application/json");
  assert.equal(requests[1].headers.get("authorization"), "Bearer write-value");
  assert.equal(requests[4].headers.get("authorization"), "Bearer delete-value");
});

test("uploads exactly the supplied Buffer or Uint8Array view", async () => {
  const endpoint = "https://agentbox.link";
  const box = {
    boxId: "view-box",
    createdAt: "2026-08-04T00:00:00.000Z",
    expiresAt: "2026-08-05T00:00:00.000Z",
    upload: { capability: "write-value", url: `${endpoint}/v1/boxes/view-box` },
    download: { capability: "read-value", url: `${endpoint}/v1/boxes/view-box` },
    delete: { capability: "delete-value", url: `${endpoint}/v1/boxes/view-box` },
  };
  const buffer = Buffer.alloc(32, 0xee);
  buffer.set([1, 2, 3], 9);
  const subarrayBacking = new Uint8Array(32).fill(0xdd);
  subarrayBacking.set([4, 5, 6], 11);
  for (const ciphertext of [buffer.subarray(9, 12), subarrayBacking.subarray(11, 14)]) {
    const expected = Uint8Array.from(ciphertext);
    const expectedSha256 = await client.sha256Hex(expected);
    const fetch = async (input, init = {}) => {
      const request = new Request(input, init);
      if (request.method === "POST") return Response.json(box, { status: 201 });
      assert.equal(request.method, "PUT");
      assert.equal(request.headers.get("content-length"), String(expected.byteLength));
      const uploaded = new Uint8Array(await request.arrayBuffer());
      assert.deepEqual(uploaded, expected);
      assert.equal(await client.sha256Hex(uploaded), expectedSha256);
      assert.equal(uploaded.byteLength, expected.byteLength);
      return new Response(null, { status: 204 });
    };
    await client.createAndUpload({
      ciphertext,
      endpoint,
      fetch,
      idempotencyKey: `view-${expected[0]}`,
      maxPriceAtomic: "10000",
      payerPrivateKey: `0x${"1".repeat(64)}`,
      paymentSignature: "saved-authorization",
    });
  }
});

test("public API rejects non-HTTPS endpoints and cross-origin capability URLs before fetching", async () => {
  let calls = 0;
  const fetch = async () => { calls += 1; return new Response(); };
  await assert.rejects(client.inspectBox({
    boxId: "box",
    capability: "value",
    endpoint: "http://agentbox.link",
    fetch,
    url: "http://agentbox.link/v1/boxes/box",
  }), /HTTPS/u);
  await assert.rejects(client.inspectBox({
    boxId: "box",
    capability: "value",
    endpoint: "https://agentbox.link",
    fetch,
    url: "https://elsewhere.example/v1/boxes/box",
  }), /trusted box/u);
  assert.equal(calls, 0);
});

test("downloads reject oversized, short, and hash-mismatched bodies", async () => {
  const base = {
    boxId: "box",
    capability: "value",
    endpoint: "https://agentbox.link",
    expectedSha256: "0".repeat(64),
    url: "https://agentbox.link/v1/boxes/box",
  };
  await assert.rejects(client.downloadAndVerify({
    ...base,
    expectedSize: 2,
    fetch: async () => new Response(new Uint8Array([1, 2, 3]), { headers: { "x-agentbox-sha256": base.expectedSha256 } }),
  }), /expected size/u);
  await assert.rejects(client.downloadAndVerify({
    ...base,
    expectedSize: 4,
    fetch: async () => new Response(new Uint8Array([1, 2, 3]), { headers: { "x-agentbox-sha256": base.expectedSha256 } }),
  }), /expected size/u);
  await assert.rejects(client.downloadAndVerify({
    ...base,
    expectedSize: 3,
    fetch: async () => new Response(new Uint8Array([1, 2, 3]), { headers: { "x-agentbox-sha256": base.expectedSha256 } }),
  }), /SHA-256/u);
});
