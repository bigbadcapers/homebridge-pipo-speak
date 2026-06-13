"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");

const { SpeakHttpServer } = require("../lib/http-server");

// A fake speaker that records calls and never touches Piper/audio.
function fakeSpeaker() {
  const calls = [];
  return {
    calls,
    say(text, volume) {
      calls.push({ text, volume });
      return Promise.resolve({ code: 200, message: `ok: ${text}` });
    },
    stats() {
      return { status: "ok", voice: "test", cacheSize: 0 };
    },
  };
}

const noopLog = { info() {}, warn() {}, error() {} };

function startServer(opts) {
  const speaker = fakeSpeaker();
  const server = new SpeakHttpServer({
    log: noopLog,
    speaker,
    port: 0, // ephemeral
    bind: "127.0.0.1",
    ...opts,
  });
  server.start();
  return new Promise((resolve, reject) => {
    const s = server.server;
    const done = () =>
      resolve({ server, speaker, port: s.address().port });
    if (s.listening) {
      return done();
    }
    s.once("listening", done);
    s.once("error", reject);
  });
}

function req(port, pathname, { method = "GET", headers, body } = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request(
      {
        host: "127.0.0.1",
        port,
        path: pathname,
        method,
        headers: { Connection: "close", ...headers },
        agent: false,
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () =>
          resolve({ status: res.statusCode, body: data.trim() }),
        );
      },
    );
    // Never hang a test: bail out if the server doesn't answer promptly.
    r.setTimeout(8000, () => r.destroy(new Error("client request timeout")));
    r.on("error", reject);
    if (body) r.write(body);
    r.end();
  });
}

test("GET /healthz is open and returns speaker stats JSON", async () => {
  const { server, port } = await startServer({ token: "sekret" });
  try {
    const res = await req(port, "/healthz");
    assert.equal(res.status, 200);
    const json = JSON.parse(res.body);
    assert.equal(json.status, "ok");
    assert.equal(json.voice, "test");
  } finally {
    server.stop();
  }
});

test("unknown route is 404", async () => {
  const { server, port } = await startServer({});
  try {
    const res = await req(port, "/nope");
    assert.equal(res.status, 404);
  } finally {
    server.stop();
  }
});

test("no token configured → GET /say works", async () => {
  const { server, speaker, port } = await startServer({});
  try {
    const res = await req(port, "/say?text=hello&volume=40");
    assert.equal(res.status, 200);
    assert.equal(speaker.calls.length, 1);
    assert.equal(speaker.calls[0].text, "hello");
    assert.equal(speaker.calls[0].volume, 40);
  } finally {
    server.stop();
  }
});

test("token configured → request without token is 401", async () => {
  const { server, speaker, port } = await startServer({ token: "sekret" });
  try {
    const res = await req(port, "/say?text=hello");
    assert.equal(res.status, 401);
    assert.equal(speaker.calls.length, 0);
  } finally {
    server.stop();
  }
});

test("token accepted via query, Bearer header, and X-Auth-Token", async () => {
  const { server, speaker, port } = await startServer({ token: "sekret" });
  try {
    assert.equal((await req(port, "/say?text=a&token=sekret")).status, 200);
    assert.equal(
      (
        await req(port, "/say?text=b", {
          headers: { authorization: "Bearer sekret" },
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await req(port, "/say?text=c", {
          headers: { "x-auth-token": "sekret" },
        })
      ).status,
      200,
    );
    assert.equal(
      (await req(port, "/say?text=d&token=wrong")).status,
      401,
    );
    assert.equal(speaker.calls.length, 3);
  } finally {
    server.stop();
  }
});

test("POST /say reads a plain-text body", async () => {
  const { server, speaker, port } = await startServer({});
  try {
    const res = await req(port, "/say", {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "from the body",
    });
    assert.equal(res.status, 200);
    assert.equal(speaker.calls[0].text, "from the body");
  } finally {
    server.stop();
  }
});
