/**
 * The queue of people asking to be let in.
 *
 * First view moved onto the router, chosen for being the smallest: one
 * fetch, one list, two actions, no danger zone, no replay player. It exists
 * to prove the mount/cleanup contract before the harder screens need it.
 *
 * It's also the first of the three copy-pasted lightboxes (styles.css:611)
 * to move onto the shared `modal()` (dom.js) instead of its own markup in
 * index.html — that markup is gone now; this module is the only place this
 * screen is described.
 */
import { sentinel } from "../lib/api.js";
import { h, fill, modal } from "../lib/dom.js";
import { throwIfAborted } from "../lib/abort.js";
import { go } from "../lib/router.js";

function requestRow(request, organisations, onDecide) {
  const picker = h(
    "select",
    { disabled: !organisations.length },
    organisations.length
      ? organisations.map((org) => h("option", { value: org, text: org }))
      : h("option", { value: "", text: "no organisation to add them to" })
  );

  const approve = h("button", {
    type: "button",
    text: "Approve",
    disabled: !organisations.length,
    on: { click: () => onDecide(request.id, "approve", picker.value) },
  });
  const decline = h("button", {
    className: "ghost danger",
    type: "button",
    text: "Decline",
    on: { click: () => onDecide(request.id, "decline") },
  });

  return h(
    "li",
    {},
    h(
      "div",
      {},
      h("div", { className: "mono", text: request.email }),
      request.note ? h("div", { className: "muted", text: request.note }) : null
    ),
    h("div", { className: "card-actions" }, picker, approve, decline)
  );
}

export async function requestsView({ signal, onCleanup }) {
  // Closing (Done, backdrop, Escape) should send the URL back to "/", but
  // the router tearing this view down on its own — because the user
  // navigated somewhere else directly — must not fight that by navigating
  // again. This flag is the difference between the two.
  let active = true;

  const list = h("ul", { className: "origin-list" });
  const error = h("p", { className: "error" });
  error.hidden = true;

  const done = h("button", { type: "button", className: "ghost", text: "Done" });
  const { close, panel } = modal({
    title: "People asking for access",
    body: h(
      "div",
      {},
      h("p", {
        className: "muted",
        text:
          "Approving someone invites them to one of your organisations in GlitchTip. They see the apps that organisation's projects allow, and nothing else.",
      }),
      list,
      error
    ),
    actions: [done],
    onClose: () => {
      if (active) void go("/");
    },
  });
  done.addEventListener("click", close);
  // Registered here, not returned at the end. load() below rethrows an
  // AbortError when the navigation that superseded this one cancels its
  // fetch — and that throw skips the return, so the router would be handed
  // no teardown and this dialog would stay open over the next screen.
  onCleanup(() => {
    active = false;
    close();
  });
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-label", "People asking for access");

  function paint(requests, organisations) {
    const pending = requests.filter((r) => r.status === "pending");
    fill(
      list,
      pending.length
        ? pending.map((request) => requestRow(request, organisations, decide))
        : h("li", { className: "empty", text: "Nobody is waiting." })
    );
  }

  async function load() {
    error.hidden = true;
    let body;
    try {
      body = await sentinel.get("/access/requests", { signal });
    } catch (err) {
      throwIfAborted(signal);
      error.hidden = false;
      error.textContent = err.message || "Could not load requests.";
      return;
    }
    throwIfAborted(signal);
    paint(body.requests || [], body.organisations || []);
  }

  async function decide(id, action, organisation) {
    error.hidden = true;
    try {
      await sentinel.post(`/access/requests/${encodeURIComponent(id)}/${action}`, { organisation }, { signal });
    } catch (err) {
      throwIfAborted(signal);
      // 501 means no service token: the decision stands, we just can't
      // carry it out from here — the receiver's own message says so.
      error.hidden = false;
      error.textContent = err.message || "Could not do that.";
      return;
    }
    throwIfAborted(signal);
    await load();
  }

  await load();

}
