# Public URLs are not stored in this repository

Three settings depend on the real, public hostnames of a deployment:

| Variable | Service | What it does |
| --- | --- | --- |
| `APP_BASE_URL` | auth-service | Origin the email-verification link points back to (`<APP_BASE_URL>/?verify=<token>`) |
| `PUBLIC_API_BASE_URL` | api-gateway | Absolute API origin written into the OpenAPI `servers` block, so Swagger's "Try it out" targets the API and not the docs host |
| `CORS_ALLOWED_ORIGINS` | api-gateway | Comma-separated origins allowed to call the API cross-origin (the docs host needs to be here) |
| `MAIL_SUPPORT` | notification-service, notification-worker | Address security emails tell customers to report to if an action wasn't theirs |

None of them are committed. Both Deployments read them from a Secret named
`bakery-public-urls` via `envFrom`, marked `optional: true` so pods still start
when it is absent.

## Creating the Secret

Once per namespace. Substitute your own hosts:

```bash
NS=bakery-prod

kubectl -n $NS create secret generic bakery-public-urls \
  --from-literal=APP_BASE_URL='https://shop.example.com' \
  --from-literal=PUBLIC_API_BASE_URL='https://shop.example.com/api' \
  --from-literal=CORS_ALLOWED_ORIGINS='https://docs.example.com,https://shop.example.com' \
  --from-literal=MAIL_SUPPORT='support@example.com'
```

Repeat for `bakery-dev` (and `bakery-uat`, if you split it out — see the
warning below).

To change a value later, replace the whole Secret and restart the two
Deployments so they pick it up:

```bash
kubectl -n $NS create secret generic bakery-public-urls \
  --from-literal=APP_BASE_URL='https://shop.example.com' \
  --from-literal=PUBLIC_API_BASE_URL='https://shop.example.com/api' \
  --from-literal=CORS_ALLOWED_ORIGINS='https://docs.example.com,https://shop.example.com' \
  --dry-run=client -o yaml | kubectl -n $NS apply -f -

kubectl -n $NS rollout restart deploy/auth-service deploy/api-gateway
```

`envFrom` is read only at pod start, so the restart is required.

## Verifying it landed

```bash
kubectl -n $NS set env deploy/auth-service --list | grep APP_BASE_URL
kubectl -n $NS set env deploy/api-gateway  --list | grep -E 'PUBLIC_API|CORS'
```

`set env --list` shows `envFrom` sources rather than the resolved values, so to
see what the container actually got:

```bash
kubectl -n $NS exec deploy/auth-service -- printenv APP_BASE_URL
kubectl -n $NS exec deploy/api-gateway  -- printenv PUBLIC_API_BASE_URL CORS_ALLOWED_ORIGINS
```

## What happens if the Secret is missing

Nothing crashes, but the behaviour degrades in ways that are easy to
misdiagnose:

- `APP_BASE_URL` unset → the verification email links to `/?verify=...` with no
  origin, so the link is unusable.
- `PUBLIC_API_BASE_URL` unset → the OpenAPI spec falls back to the relative
  `/api`, which on a separate docs host resolves to the docs listener and
  returns `404 {"error":"Not found"}` for every "Try it out".
- `CORS_ALLOWED_ORIGINS` unset → CORS middleware is disabled entirely and
  cross-origin calls from the docs host fail at preflight.
- `MAIL_SUPPORT` unset → the "report it to …" sentence is omitted from
  security emails. Nothing breaks and no dead address is shown, but customers
  who receive an unexpected reset mail are left with no way to flag it.

## The docs Ingress

`k8s/base/ingress/api-docs-ingress.yaml` ships with the placeholder host
`docs.example.invalid`. Either override it with a local patch that you do not
commit, or leave the file out of `k8s/base/ingress/kustomization.yaml` and
manage that Ingress outside git entirely — it only needs to route to Service
`api-docs` on port 3100.

Note the production overlay already has `#- ../../base/ingress` commented out,
so nothing from `base/ingress` is deployed to `bakery-prod` regardless. The
`api-docs` Service itself lives in `base/services` and *is* deployed there.

## Related: overlay namespace

`k8s/overlays/uat/kustomization.yaml` sets `namespace: bakery-dev`, the same
namespace as the dev overlay, so dev and uat currently deploy on top of each
other. That predates these changes and is left alone here, but it means a
single `bakery-public-urls` Secret in `bakery-dev` is shared by both.
