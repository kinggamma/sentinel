**What this changes**

<!-- The problem first, the fix second. -->

**How it was tested**

<!-- There's no automated suite yet, so say what you actually ran against a
     live stack — which endpoints, which app, which browser. -->

**Checklist**

- [ ] Tested against a running `docker compose up -d` stack
- [ ] No secrets, tokens, DSN keys, or personal data in the diff
- [ ] Rebuilt the browser bundle if `sdk/` changed
      (`./sdk/build-moodle-bundle.sh <dest>`)
- [ ] Docs updated if behaviour or configuration changed
- [ ] Privacy defaults not weakened (input masking, page exclusion,
      retention) — or the change is opt-in and documented
