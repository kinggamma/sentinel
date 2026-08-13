#!/usr/bin/env node
/**
 * The router, driven against a stub DOM.
 *
 * Its pattern compiler is real logic that fails silently — a pattern that
 * never matches shows an empty screen rather than an error, which is how the
 * first version shipped broken: it escaped regex metacharacters and then
 * looked for an escaped slash, which the escaping never produced, so every
 * route with a parameter matched nothing.
 *
 * The rest is browser plumbing, and the parts of it that can go wrong go
 * wrong quietly too. A slow view painting over the screen that replaced it, a
 * cleanup that throws and strands the user, a fragment click that tears down
 * the screen it was meant to scroll: none of those raise anything. The stub
 * below is small enough to read in one sitting and exercises all of them
 * before a single view is wired to a route.
 */

let passed = 0;
const failures = [];

async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    process.stdout.write(`  ✓ ${name}\n`);
  } catch (error) {
    failures.push(name);
    process.stdout.write(`  ✗ ${name}\n      ${error.message}\n`);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function same(got, wanted, message) {
  const a = JSON.stringify(got);
  const b = JSON.stringify(wanted);
  assert(a === b, `${message}: got ${a}, wanted ${b}`);
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ------------------------------------------------------------ the stub DOM

const ORIGIN = "http://localhost:8000";

class StubElement {
  constructor(tag) {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.attributes = new Map();
    this.className = "";
    this.textContent = "";
  }
  setAttribute(key, value) {
    this.attributes.set(key, String(value));
  }
  getAttribute(key) {
    return this.attributes.has(key) ? this.attributes.get(key) : null;
  }
  hasAttribute(key) {
    return this.attributes.has(key);
  }
  replaceChildren(...children) {
    this.children = children;
  }
  append(...children) {
    this.children.push(...children);
  }
  closest(selector) {
    if (selector !== "a[href]") return null;
    return this.tagName === "A" && this.hasAttribute("href") ? this : null;
  }
}

/** A fresh window/document/location/history, and a fresh copy of the router. */
async function harness(seed = "/sentinel/") {
  const listeners = new Map();
  const stack = [];

  const location = { origin: ORIGIN, pathname: "/", search: "", hash: "", href: ORIGIN };
  const apply = (url) => {
    const parsed = new URL(url, ORIGIN);
    location.pathname = parsed.pathname;
    location.search = parsed.search;
    location.hash = parsed.hash;
    location.href = parsed.href;
  };
  apply(seed);

  const on = (type, handler) => {
    if (!listeners.has(type)) listeners.set(type, []);
    listeners.get(type).push(handler);
  };
  const off = (type, handler) => {
    listeners.set(type, (listeners.get(type) || []).filter((h) => h !== handler));
  };
  const fire = (type, event) => (listeners.get(type) || []).slice().forEach((h) => h(event));

  let scrolled = 0;

  globalThis.location = location;
  globalThis.history = {
    pushState(_state, _title, url) {
      stack.push(location.pathname + location.search + location.hash);
      apply(url);
    },
    replaceState(_state, _title, url) {
      apply(url);
    },
  };
  globalThis.window = {
    addEventListener: on,
    removeEventListener: off,
    scrollTo: () => {
      scrolled += 1;
    },
  };
  globalThis.document = {
    addEventListener: on,
    removeEventListener: off,
    createElement: (tag) => new StubElement(tag),
  };

  // A fresh module each time: routes live at module scope, and one test's
  // routes must not leak into the next.
  const router = await import(`../public/lib/router.js?case=${harness.n++}`);
  const outlet = new StubElement("main");

  return {
    router,
    outlet,
    location,
    get scrolled() {
      return scrolled;
    },
    /** Step back in history the way a browser does: change URL, then notify. */
    async back() {
      apply(stack.pop() ?? "/");
      fire("popstate", {});
      await delay(0);
    },
    /** A left-click on an anchor, unless the overrides say otherwise. */
    async click(href, { attrs = {}, ...overrides } = {}) {
      const anchor = new StubElement("a");
      anchor.setAttribute("href", href);
      for (const [key, value] of Object.entries(attrs)) anchor.setAttribute(key, value);
      const event = {
        button: 0,
        defaultPrevented: false,
        metaKey: false,
        ctrlKey: false,
        shiftKey: false,
        altKey: false,
        target: anchor,
        preventDefault() {
          this.defaultPrevented = true;
        },
        ...overrides,
      };
      fire("click", event);
      await delay(0);
      return event;
    },
  };
}
harness.n = 0;

/** What the outlet is showing, as text. */
const shown = (outlet) => outlet.children.map((child) => child.textContent ?? "").join("");
const paint = (outlet, text) => outlet.replaceChildren({ textContent: text });

// The router logs teardown and render failures; the tests provoke both.
const quiet = () => {
  const warn = console.warn;
  const error = console.error;
  const lines = [];
  console.warn = (...args) => lines.push(args.join(" "));
  console.error = (...args) => lines.push(args.join(" "));
  return {
    lines,
    restore() {
      console.warn = warn;
      console.error = error;
    },
  };
};

// ------------------------------------------------------- the pattern compiler

process.stdout.write("\nPatterns match the paths they name\n");

const patterns = [
  ["/", "/", {}],
  // currentPath() normalises an empty path to "/", so the matcher never
  // sees "" and isn't asked to handle it.
  ["/issues", "/issues", {}],
  ["/issues", "/issues/", {}],
  ["/issues", "/issue", null],
  ["/issues/:id", "/issues/42", { id: "42" }],
  ["/issues/:id", "/issues", null],
  ["/issues/:id", "/issues/42/extra", null],
  ["/issues/:id", "/issues/a%20b", { id: "a b" }],
  ["/reports/:app", "/reports/e-library-admin", { app: "e-library-admin" }],
  ["/reports/:app", "/reports/", null],
  ["/settings/teams/:slug", "/settings/teams/just-me", { slug: "just-me" }],
  ["/settings/teams/:slug/members", "/settings/teams/x/members", { slug: "x" }],
];

for (const [pattern, input, expected] of patterns) {
  await test(`${pattern} vs ${input}`, async () => {
    const { router, outlet } = await harness(`/sentinel${input}`);
    let seen = null;
    router.route(pattern, ({ params }) => {
      seen = params;
    });
    await router.start({ outlet });
    same(seen, expected, `${pattern} vs ${input}`);
    router.stop();
  });
}

// --------------------------------------------------------------- addressing

process.stdout.write("\nA URL is the whole address\n");

await test("a deep link mounts its view with its parameters", async () => {
  const { router, outlet } = await harness("/sentinel/issues/42");
  router.route("/issues/:id", ({ params, outlet: node }) => paint(node, `issue ${params.id}`));
  await router.start({ outlet });
  same(shown(outlet), "issue 42", "deep link");
  router.stop();
});

await test("a query string and a fragment reach the view", async () => {
  const { router, outlet } = await harness("/sentinel/issues?query=is%3Aunresolved&sort=new#frame-3");
  let context = null;
  router.route("/issues", (ctx) => {
    context = ctx;
  });
  await router.start({ outlet });
  same(context.query, { query: "is:unresolved", sort: "new" }, "query");
  same(context.hash, "frame-3", "fragment");
  router.stop();
});

await test("a path outside the mount is not mistaken for one inside it", async () => {
  const { router, outlet } = await harness("/sentinelfoo/issues");
  router.route("/issues", ({ outlet: node }) => paint(node, "issues"));
  router.setNotFound(({ outlet: node }) => paint(node, "not found"));
  await router.start({ outlet });
  same(shown(outlet), "not found", "/sentinelfoo is somebody else's path");
  router.stop();
});

await test("an unregistered path falls through to the not-found view", async () => {
  const { router, outlet } = await harness("/sentinel/nowhere");
  router.route("/issues", ({ outlet: node }) => paint(node, "issues"));
  router.setNotFound(({ outlet: node }) => paint(node, "not found"));
  await router.start({ outlet });
  same(shown(outlet), "not found", "unregistered path");
  router.stop();
});

// ------------------------------------------------------------- back and forth

process.stdout.write("\nHistory moves the screen, and fragments do not\n");

await test("popstate renders the screen it lands on", async () => {
  const { router, outlet, back } = await harness("/sentinel/issues");
  router.route("/issues", ({ outlet: node }) => paint(node, "issues"));
  router.route("/reports", ({ outlet: node }) => paint(node, "reports"));
  await router.start({ outlet });
  await router.go("/reports");
  same(shown(outlet), "reports", "after go");
  await back();
  same(shown(outlet), "issues", "after back");
  router.stop();
});

await test("a fragment-only navigation keeps the mounted view", async () => {
  const { router, outlet, location, back } = await harness("/sentinel/issues/42");
  let mounts = 0;
  router.route("/issues/:id", ({ outlet: node }) => {
    mounts += 1;
    paint(node, "issue 42");
  });
  await router.start({ outlet });

  await router.go("/issues/42#frame-3");
  same(location.hash, "#frame-3", "the fragment is in the URL");
  same(mounts, 1, "no remount on a fragment");

  await back();
  same(mounts, 1, "no remount when the fragment is popped off");
  router.stop();
});

await test("navigating to the URL already showing does nothing", async () => {
  const { router, outlet } = await harness("/sentinel/issues");
  let mounts = 0;
  router.route("/issues", () => {
    mounts += 1;
  });
  await router.start({ outlet });
  await router.go("/issues");
  same(mounts, 1, "same URL is a no-op");
  router.stop();
});

await test("refresh remounts the same URL on purpose", async () => {
  const { router, outlet } = await harness("/sentinel/issues");
  let mounts = 0;
  router.route("/issues", () => {
    mounts += 1;
  });
  await router.start({ outlet });
  await router.refresh();
  same(mounts, 2, "refresh forces a remount");
  router.stop();
});

await test("a pushed navigation scrolls to the top, a popped one does not", async () => {
  const box = await harness("/sentinel/issues");
  const { router, outlet, back } = box;
  router.route("/issues", () => {});
  router.route("/reports", () => {});
  await router.start({ outlet });
  same(box.scrolled, 0, "the first render is not a navigation");
  await router.go("/reports");
  same(box.scrolled, 1, "pushed");
  await back();
  same(box.scrolled, 1, "popped, so the browser restores the position");
  router.stop();
});

// ---------------------------------------------------------------- the clicks

process.stdout.write("\nOnly a plain click on an in-app link is ours\n");

await test("a plain left-click on an in-app link is intercepted", async () => {
  const { router, outlet, click, location } = await harness("/sentinel/issues");
  router.route("/issues", ({ outlet: node }) => paint(node, "issues"));
  router.route("/reports", ({ outlet: node }) => paint(node, "reports"));
  await router.start({ outlet });
  const event = await click("/sentinel/reports");
  assert(event.defaultPrevented, "the click should have been taken");
  same(location.pathname, "/sentinel/reports", "URL");
  same(shown(outlet), "reports", "screen");
  router.stop();
});

await test("a link's query and fragment survive the interception", async () => {
  const { router, outlet, click, location } = await harness("/sentinel/issues");
  let context = null;
  router.route("/issues", (ctx) => {
    context = ctx;
  });
  router.route("/reports", (ctx) => {
    context = ctx;
  });
  await router.start({ outlet });
  await click("/sentinel/reports?app=e-library#latest");
  same(location.search, "?app=e-library", "query");
  same(location.hash, "#latest", "fragment");
  same(context.query, { app: "e-library" }, "the view is told");
  router.stop();
});

const passedThrough = [
  ["a middle-click", "/sentinel/reports", { button: 1 }],
  ["a command-click", "/sentinel/reports", { metaKey: true }],
  ["a control-click", "/sentinel/reports", { ctrlKey: true }],
  ["a shift-click", "/sentinel/reports", { shiftKey: true }],
  ["an alt-click", "/sentinel/reports", { altKey: true }],
  ["a link opening in a new tab", "/sentinel/reports", { attrs: { target: "_blank" } }],
  ["a download link", "/sentinel/reports", { attrs: { download: "" } }],
  ["a link marked external", "/sentinel/reports", { attrs: { rel: "noopener external" } }],
  ["a link to another origin", "https://glitchtip.com/docs", {}],
  ["a mailto: link", "mailto:someone@example.com", {}],
  ["a link to GlitchTip's own screens", "/glitchtip/organizations", {}],
  ["a link to the Django admin", "/admin/", {}],
];

for (const [what, href, overrides] of passedThrough) {
  await test(`${what} is left to the browser`, async () => {
    const { router, outlet, click, location } = await harness("/sentinel/issues");
    router.route("/issues", ({ outlet: node }) => paint(node, "issues"));
    router.route("/reports", ({ outlet: node }) => paint(node, "reports"));
    await router.start({ outlet });
    const event = await click(href, overrides);
    assert(!event.defaultPrevented, "the browser should have kept this click");
    same(location.pathname, "/sentinel/issues", "the URL should not have moved");
    same(shown(outlet), "issues", "the screen should not have moved");
    router.stop();
  });
}

await test("a click something else already handled is left alone", async () => {
  // Seeded as prevented on the way in, so the flag proves nothing here — what
  // matters is that a handler which already claimed the click keeps it.
  const { router, outlet, click, location } = await harness("/sentinel/issues");
  router.route("/issues", ({ outlet: node }) => paint(node, "issues"));
  router.route("/reports", ({ outlet: node }) => paint(node, "reports"));
  await router.start({ outlet });
  await click("/sentinel/reports", { defaultPrevented: true });
  same(location.pathname, "/sentinel/issues", "the URL should not have moved");
  same(shown(outlet), "issues", "the screen should not have moved");
  router.stop();
});

await test("a same-page fragment link is left to the browser to scroll", async () => {
  const { router, outlet, click } = await harness("/sentinel/issues/42");
  let mounts = 0;
  router.route("/issues/:id", ({ outlet: node }) => {
    mounts += 1;
    paint(node, "issue 42");
  });
  await router.start({ outlet });
  const event = await click("/sentinel/issues/42#frame-3");
  assert(!event.defaultPrevented, "the browser scrolls to fragments better than we do");
  same(mounts, 1, "and the screen stays mounted");
  router.stop();
});

// ----------------------------------------------------------------- teardown

process.stdout.write("\nEvery view is torn down, and a bad teardown blocks nothing\n");

await test("cleanup runs before the next view mounts", async () => {
  const { router, outlet } = await harness("/sentinel/issues");
  const order = [];
  router.route("/issues", ({ outlet: node }) => {
    order.push("mount issues");
    paint(node, "issues");
    return () => order.push("clean issues");
  });
  router.route("/reports", ({ outlet: node }) => {
    order.push("mount reports");
    paint(node, "reports");
  });
  await router.start({ outlet });
  await router.go("/reports");
  same(order, ["mount issues", "clean issues", "mount reports"], "order");
  router.stop();
});

await test("a cleanup that throws does not strand the user", async () => {
  const { router, outlet } = await harness("/sentinel/issues");
  const log = quiet();
  try {
    router.route("/issues", ({ outlet: node }) => {
      paint(node, "issues");
      return () => {
        throw new Error("cleanup blew up");
      };
    });
    router.route("/reports", ({ outlet: node }) => paint(node, "reports"));
    await router.start({ outlet });
    await router.go("/reports");
    same(shown(outlet), "reports", "the next screen still mounted");
    assert(log.lines.some((line) => line.includes("view cleanup failed")), "and the failure was reported");
  } finally {
    log.restore();
    router.stop();
  }
});

// ------------------------------------------------------- layered routes

await test("a layered route tears down every view it mounted", async () => {
  const { router, outlet } = await harness("/sentinel/requests");
  const order = [];
  const background = ({ outlet: node }) => {
    paint(node, "landing");
    return () => order.push("clean landing");
  };
  const dialog = () => {
    order.push("mount dialog");
    return () => order.push("clean dialog");
  };
  router.route("/requests", router.layer(background, dialog));
  router.route("/elsewhere", ({ outlet: node }) => paint(node, "elsewhere"));

  await router.start({ outlet });
  await router.go("/elsewhere");
  // Reverse order: the thing on top comes off first.
  same(order, ["mount dialog", "clean dialog", "clean landing"], "teardown order");
  router.stop();
});

await test("a layer whose later view throws cleans up the earlier one", async () => {
  const { router, outlet } = await harness("/sentinel/requests");
  const log = quiet();
  try {
    const cleaned = [];
    const background = ({ outlet: node }) => {
      paint(node, "landing");
      return () => cleaned.push("landing");
    };
    const dialog = () => {
      throw new Error("dialog could not mount");
    };
    router.route("/requests", router.layer(background, dialog));
    await router.start({ outlet });

    // The router never receives a cleanup for a render that threw, so if the
    // layer doesn't do it here the landing's timers outlive it forever.
    same(cleaned, ["landing"], "the mounted view was torn down");
    assert(shown(outlet).includes("dialog could not mount"), "and the error still surfaced");
  } finally {
    log.restore();
    router.stop();
  }
});

await test("a layered route superseded mid-mount cleans up what it mounted", async () => {
  const { router, outlet } = await harness("/sentinel/requests");
  const cleaned = [];
  const background = ({ outlet: node }) => {
    paint(node, "landing");
    return () => cleaned.push("landing");
  };
  const slowDialog = async () => {
    await delay(30);
    return () => cleaned.push("dialog");
  };
  router.route("/requests", router.layer(background, slowDialog));
  router.route("/elsewhere", ({ outlet: node }) => paint(node, "elsewhere"));

  const first = router.start({ outlet });
  // Navigate away while the dialog half is still mounting.
  await delay(5);
  const second = router.go("/elsewhere");
  await Promise.all([first, second]);

  same(shown(outlet), "elsewhere", "the later navigation is the one showing");
  // Both halves of the superseded render are accounted for: each registered
  // its cleanup as it mounted, so the router unwinds them itself.
  same(cleaned.sort(), ["dialog", "landing"], "both layers were torn down");
  router.stop();
});

await test("a view that throws after allocating still has its cleanup run", async () => {
  const { router, outlet } = await harness("/sentinel/reports");
  const log = quiet();
  try {
    const cleaned = [];
    router.route("/reports", ({ onCleanup }) => {
      // The shape every real view has: open something, then go and fetch.
      onCleanup(() => cleaned.push("lightbox listener"));
      onCleanup(() => cleaned.push("object urls"));
      throw new Error("could not load reports");
    });
    await router.start({ outlet });

    same(cleaned, ["object urls", "lightbox listener"], "unwound in reverse, none missed");
    assert(shown(outlet).includes("could not load reports"), "and the error still surfaced");
  } finally {
    log.restore();
    router.stop();
  }
});

await test("an aborted view's registered cleanups run, quietly", async () => {
  const { router, outlet } = await harness("/sentinel/reports");
  const cleaned = [];
  router.route("/reports", async ({ signal, onCleanup }) => {
    onCleanup(() => cleaned.push("player"));
    await delay(30);
    // What throwIfAborted does, and what fetch does on a cancelled request:
    // the view never reaches its own return, so this is the only teardown
    // anyone is ever going to be handed.
    if (signal.aborted) throw Object.assign(new Error("aborted"), { name: "AbortError" });
    return () => cleaned.push("unreachable");
  });
  router.route("/elsewhere", ({ outlet: node }) => paint(node, "elsewhere"));

  const first = router.start({ outlet });
  await delay(5);
  const second = router.go("/elsewhere");
  await Promise.all([first, second]);

  same(cleaned, ["player"], "the replay player was destroyed");
  same(shown(outlet), "elsewhere", "and the abort was not reported as a failure");
  router.stop();
});

await test("a returned cleanup runs before the ones the view registered", async () => {
  const { router, outlet } = await harness("/sentinel/reports");
  const order = [];
  router.route("/reports", ({ onCleanup }) => {
    onCleanup(() => order.push("registered first"));
    onCleanup(() => order.push("registered second"));
    return () => order.push("returned");
  });
  router.route("/elsewhere", ({ outlet: node }) => paint(node, "elsewhere"));

  await router.start({ outlet });
  await router.go("/elsewhere");
  same(order, ["returned", "registered second", "registered first"], "teardown order");
  router.stop();
});

await test("stop() tears down the mounted view and stops listening", async () => {
  const { router, outlet, click, location } = await harness("/sentinel/issues");
  let cleaned = 0;
  router.route("/issues", () => () => {
    cleaned += 1;
  });
  router.route("/reports", () => {});
  await router.start({ outlet });
  router.stop();
  same(cleaned, 1, "cleanup ran");
  const event = await click("/sentinel/reports");
  assert(!event.defaultPrevented, "clicks are no longer ours");
  same(location.pathname, "/sentinel/issues", "and the URL did not move");
});

// --------------------------------------------------------------- the race

process.stdout.write("\nA slow view cannot overwrite the screen that replaced it\n");

await test("a superseded view is told to stop, and is torn down", async () => {
  const { router, outlet } = await harness("/sentinel/slow");
  const cleaned = [];
  let slowSignal = null;

  router.route("/slow", async ({ outlet: node, signal }) => {
    slowSignal = signal;
    await delay(20);
    // The contract: check before painting, because by now you may have lost.
    if (!signal.aborted) paint(node, "slow");
    return () => cleaned.push("slow");
  });
  router.route("/fast", ({ outlet: node }) => {
    paint(node, "fast");
    return () => cleaned.push("fast");
  });

  const first = router.start({ outlet });
  const second = router.go("/fast");
  await Promise.all([first, second]);
  await delay(40);

  assert(slowSignal.aborted, "the slow view should have been told it lost");
  same(shown(outlet), "fast", "the screen belongs to the view that won");
  same(cleaned, ["slow"], "and the loser was torn down when it finished");

  await router.go("/issues");
  same(cleaned, ["slow", "fast"], "the winner is torn down on the next navigation");
  router.stop();
});

await test("a slow view that ignores the signal never becomes the mounted view", async () => {
  const { router, outlet } = await harness("/sentinel/slow");
  const cleaned = [];

  // Deliberately rude: paints regardless. It still must not be left mounted,
  // or its cleanup would run in place of the real screen's.
  router.route("/slow", async ({ outlet: node }) => {
    await delay(20);
    paint(node, "slow");
    return () => cleaned.push("slow");
  });
  router.route("/fast", ({ outlet: node }) => {
    paint(node, "fast");
    return () => cleaned.push("fast");
  });
  router.route("/issues", ({ outlet: node }) => paint(node, "issues"));

  const first = router.start({ outlet });
  const second = router.go("/fast");
  await Promise.all([first, second]);
  await delay(40);

  same(cleaned, ["slow"], "the loser cleaned up after itself");
  await router.go("/issues");
  same(cleaned, ["slow", "fast"], "and /fast was what was mounted, so /fast is what was cleaned");
  router.stop();
});

await test("the last of several rapid navigations is the one that shows", async () => {
  const { router, outlet } = await harness("/sentinel/a");
  const make = (name, ms) => async ({ outlet: node, signal }) => {
    await delay(ms);
    if (!signal.aborted) paint(node, name);
  };
  router.route("/a", make("a", 30));
  router.route("/b", make("b", 20));
  router.route("/c", make("c", 1));

  const all = [router.start({ outlet }), router.go("/b"), router.go("/c")];
  await Promise.all(all);
  await delay(60);
  same(shown(outlet), "c", "the newest navigation wins regardless of who finishes first");
  router.stop();
});

// -------------------------------------------------------------- view failure

process.stdout.write("\nA view that fails says so, and the app keeps working\n");

await test("a view that throws shows its message", async () => {
  const { router, outlet } = await harness("/sentinel/issues");
  const log = quiet();
  try {
    router.route("/issues", () => {
      throw new Error("Couldn't reach the server.");
    });
    router.route("/reports", ({ outlet: node }) => paint(node, "reports"));
    await router.start({ outlet });
    same(shown(outlet), "Couldn't reach the server.", "the message");
    same(outlet.children[0].className, "error", "styled as an error");
    await router.go("/reports");
    same(shown(outlet), "reports", "and navigation still works afterwards");
  } finally {
    log.restore();
    router.stop();
  }
});

await test("an aborted view is not reported as a failure", async () => {
  const { router, outlet } = await harness("/sentinel/slow");
  const log = quiet();
  try {
    router.route("/slow", async ({ signal }) => {
      await delay(20);
      // What fetch(…, { signal }) throws when the navigation moved on.
      const error = new Error("The operation was aborted.");
      error.name = "AbortError";
      throw error;
    });
    router.route("/fast", ({ outlet: node }) => paint(node, "fast"));

    const first = router.start({ outlet });
    const second = router.go("/fast");
    await Promise.all([first, second]);
    await delay(40);

    same(shown(outlet), "fast", "the screen is untouched");
    assert(!log.lines.some((line) => line.includes("view failed to render")), "and nothing was logged as broken");
  } finally {
    log.restore();
    router.stop();
  }
});

process.stdout.write(`\n${passed} passed, ${failures.length} failed\n`);
if (failures.length) process.exit(1);
