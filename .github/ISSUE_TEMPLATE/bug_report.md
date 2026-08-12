---
name: Bug report
about: Something in the pipeline doesn't work as documented
labels: bug
---

**What happened**

<!-- What you saw. Paste exact error text where you can. -->

**What you expected**

**Steps to reproduce**

1.
2.
3.

**Where it broke**

<!-- Which piece: receiver, viewer UI, browser SDK, Moodle assets, compose stack -->

**Environment**

- Pipeline version / commit:
- Host: local machine / server
- Integrating app's stack (browser JS, Node, Python, PHP, Moodle, …):
- Browser + version, if it's a viewer or SDK issue:

**Logs**

<!-- Please redact STAFF_API_TOKEN, DSN keys, and anything personal. -->

```
docker compose logs --tail 50 feedback-receiver
```
