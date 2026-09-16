# PayTech — Distributed Payment System

A production-shaped microservice architecture built around real distributed-systems problems: idempotency, partial failures, at-least-once delivery, the transactional outbox pattern, and double-entry bookkeeping.

---

## Architecture

```
Client
  │
  ▼  X-Api-Key: <key>
API Gateway
  │  injects X-Authenticated-User-Id
  │
  ├──► User Service         GET /users/:id
  │
  ├──► Payment Service      POST /payments   GET /payments/:id
  │        │  Idempotency-Key guard
  │        │
  │        ├──► Fraud Service    (sync HTTP — on critical path)
  │        │        rule-based scorer → approved | review | rejected
  │        │
  │        ├──► Ledger Service   (sync HTTP — idempotent double-entry)
  │        │
  │        ├──► PostgreSQL       (payments + idempotency_keys + outbox_events)
  │        │
  │        └──► Outbox Relay     (polls outbox every 2 s)
  │                  │
  │                  ▼  AMQP topic exchange: paytech.events
  │                     routing key: payment.succeeded | payment.failed
  │                            │
  │              ┌─────────────┤
  │              ▼             ▼
  │   notification-service   order-service
  │   (at-least-once         (at-least-once
  │    consumer)              consumer)
  │
  └──► Order Service         POST /orders   GET /orders/:id
```

### Services

| Service | Port | Responsibilities |
|---------|------|-----------------|
| api-gateway | 3000 | Auth, rate-limiting, reverse proxy |
| user-service | 3001 | User records |
| payment-service | 3002 | Payment orchestration, idempotency, outbox |
| order-service | 3003 | Orders, reacts to payment events |
| notification-service | 3004 | Email notifications, deduplication |
| fraud-service | 3005 | Synchronous risk scoring |
| ledger-service | 3006 | Double-entry bookkeeping |

---

## Repository Structure

```
paytech/
├── .dockerignore
├── .github/
│   └── workflows/
│       └── build-push.yml        # CI/CD → GCP Artifact Registry
├── infra/
│   └── postgres/
│       ├── migrate.js            # Standalone migration runner (cloud one-off task)
│       └── migrations/
│           ├── 001_users.sql
│           ├── 002_payments.sql  # includes idempotency_keys table
│           ├── 003_orders.sql
│           ├── 004_ledger.sql    # double-entry tables
│           ├── 005_outbox.sql    # transactional outbox table
│           └── 006_notification_log.sql
├── shared/
│   └── src/
│       ├── db.js                 # pg pool + withTransaction
│       ├── amqp.js               # publish + consume helpers
│       ├── idempotency.js        # withIdempotency() guard
│       ├── outbox.js             # insertOutboxEvent + startOutboxRelay
│       ├── httpClient.js         # retry + back-off HTTP client
│       ├── errors.js             # AppError hierarchy + Express handler
│       └── logger.js             # structured JSON logger (pino)
└── services/
    ├── api-gateway/
    ├── user-service/
    ├── payment-service/
    ├── order-service/
    ├── notification-service/
    ├── fraud-service/
    └── ledger-service/
```

Each service contains:
- `src/` — application source
- `Dockerfile` — build context is repo root
- `.env.example` — all required environment variables documented

---

## GitHub Actions — CI/CD to Artifact Registry

The workflow at `.github/workflows/build-push.yml` builds all 7 service images in parallel and pushes them to GCP Artifact Registry on every merge to `main`.

### What it does

```
push to main
  └── matrix build (7 jobs, parallel)
        ├── Authenticate to GCP (Workload Identity Federation — no JSON keys)
        ├── docker build -f services/<service>/Dockerfile .
        ├── push :<short-sha>   ← pin this in your k8s manifests
        └── push :latest

pull_request
  └── matrix build (build only, no push — verifies the Dockerfile compiles)
```

Image tags produced for commit `a1b2c3d4`:
```
us-east1-docker.pkg.dev/<project>/paytech/api-gateway:a1b2c3d4
us-east1-docker.pkg.dev/<project>/paytech/api-gateway:latest
# ... same for all 7 services
```

### Required GitHub secrets and variables

Go to **Settings → Secrets and variables → Actions** in your repository.

| Type | Name | Value |
|------|------|-------|
| Secret | `GCP_WIF_PROVIDER` | Workload Identity Provider resource name (see setup below) |
| Secret | `GCP_WIF_SA` | Service account email that WIF impersonates |
| Variable | `GCP_PROJECT_ID` | Your GCP project id |

### One-time GCP setup

Run these once before your first push.

```bash
export PROJECT_ID=clear-shadow-508714-b2
export REGION=us-east1
export GITHUB_ORG=Elvisdomain
export GITHUB_REPO=paytech

# 1. Enable required APIs
gcloud services enable \
  artifactregistry.googleapis.com \
  iamcredentials.googleapis.com \
  --project=$PROJECT_ID

# 2. Create Artifact Registry repository
gcloud artifacts repositories create paytech \
  --repository-format=docker \
  --location=$REGION \
  --project=$PROJECT_ID

# 3. Create a dedicated service account for GitHub Actions
gcloud iam service-accounts create github-actions \
  --display-name="GitHub Actions — PayTech" \
  --project=$PROJECT_ID

# 4. Grant it permission to push images
gcloud projects add-iam-policy-binding $PROJECT_ID \
  --member="serviceAccount:github-actions@$PROJECT_ID.iam.gserviceaccount.com" \
  --role="roles/artifactregistry.writer"

# 5. Create a Workload Identity Pool
gcloud iam workload-identity-pools create github \
  --location=global \
  --display-name="GitHub Actions pool" \
  --project=$PROJECT_ID

# 6. Create a provider inside the pool
gcloud iam workload-identity-pools providers create-oidc github-provider \
  --location=global \
  --workload-identity-pool=github \
  --display-name="GitHub provider" \
  --issuer-uri="https://token.actions.githubusercontent.com" \
  --attribute-mapping="google.subject=assertion.sub,attribute.repository=assertion.repository" \
  --attribute-condition="assertion.repository=='$GITHUB_ORG/$GITHUB_REPO'" \
  --project=$PROJECT_ID

# 7. Allow the WIF provider to impersonate the service account
POOL_ID=$(gcloud iam workload-identity-pools describe github \
  --location=global \
  --project=$PROJECT_ID \
  --format="value(name)")

gcloud iam service-accounts add-iam-policy-binding \
  github-actions@$PROJECT_ID.iam.gserviceaccount.com \
  --role="roles/iam.workloadIdentityUser" \
  --member="principalSet://iam.googleapis.com/$POOL_ID/attribute.repository/$GITHUB_ORG/$GITHUB_REPO" \
  --project=$PROJECT_ID

# 8. Get the values to paste into GitHub Secrets
echo "--- GCP_WIF_PROVIDER ---"
gcloud iam workload-identity-pools providers describe github-provider \
  --location=global \
  --workload-identity-pool=github \
  --project=$PROJECT_ID \
  --format="value(name)"

echo "--- GCP_WIF_SA ---"
echo "github-actions@$PROJECT_ID.iam.gserviceaccount.com"
```

Paste the output of step 8 into GitHub → Settings → Secrets and variables → Actions.

### Referencing images in Kubernetes

After a successful build, every image is tagged with the short commit SHA. Use the SHA tag — not `:latest` — in your manifests so deployments are deterministic and rollbacks are a single `kubectl apply`:

```yaml
# Example deployment.yaml
containers:
  - name: api-gateway
    image: us-east1-docker.pkg.dev/<project>/paytech/api-gateway:a1b2c3d4
```

The Actions **summary tab** on each run lists all 7 image refs ready to copy.

---

## Deploying to GCP

### Managed services

| Concern | GCP service |
|---------|-------------|
| Container runtime | GKE or Cloud Run |
| Database | Cloud SQL (PostgreSQL 16) |
| Message broker | CloudAMQP (managed RabbitMQ) |
| Container registry | Artifact Registry |
| Secrets | Secret Manager |

### One-time infrastructure setup

```bash
export PROJECT_ID=clear-shadow-508714-b2
export REGION=us-east1

# Enable required APIs
gcloud services enable \
  container.googleapis.com \
  sqladmin.googleapis.com \
  artifactregistry.googleapis.com \
  secretmanager.googleapis.com \
  --project=$PROJECT_ID

# Create Cloud SQL instance (PostgreSQL 16)
gcloud sql instances create paytech-pg \
  --database-version=POSTGRES_16 \
  --tier=db-g1-small \
  --region=$REGION \
  --project=$PROJECT_ID

gcloud sql databases create paytech \
  --instance=paytech-pg \
  --project=$PROJECT_ID

gcloud sql users create paytech \
  --instance=paytech-pg \
  --password=<strong-password> \
  --project=$PROJECT_ID

# Store secrets in Secret Manager
echo -n "<strong-password>" | \
  gcloud secrets create paytech-db-password \
    --data-file=- --project=$PROJECT_ID

echo -n "amqps://user:pass@host/vhost" | \
  gcloud secrets create paytech-rabbitmq-url \
    --data-file=- --project=$PROJECT_ID

echo -n "key-one,key-two" | \
  gcloud secrets create paytech-api-keys \
    --data-file=- --project=$PROJECT_ID

# Create a service account for the workloads
gcloud iam service-accounts create paytech-workload \
  --display-name="PayTech Workload SA" \
  --project=$PROJECT_ID

for role in \
  roles/cloudsql.client \
  roles/secretmanager.secretAccessor \
  roles/artifactregistry.reader; do
  gcloud projects add-iam-policy-binding $PROJECT_ID \
    --member="serviceAccount:paytech-workload@$PROJECT_ID.iam.gserviceaccount.com" \
    --role="$role"
done
```

### Run migrations

Migrations must be run once after the database is provisioned, and again after any new migration file is added. The runner connects directly to Cloud SQL:

```bash
# From a machine with Cloud SQL Auth Proxy or inside a Cloud Run Job
node infra/postgres/migrate.js
```

Required environment variables:
```
POSTGRES_HOST=/cloudsql/<project>:<region>:<instance>   # Cloud SQL socket
POSTGRES_DB=paytech
POSTGRES_USER=paytech
POSTGRES_PASSWORD=<from Secret Manager>
```

### POSTGRES_HOST for Cloud SQL

Cloud SQL uses a Unix socket via the Cloud SQL Auth Proxy (built into Cloud Run, or run as a sidecar in GKE):
```
POSTGRES_HOST=/cloudsql/clear-shadow-508714-b2:us-east1:paytech-pg
```

---

## Secrets management

Never put real credentials in environment variables directly or in source control. Inject them at runtime from Secret Manager.

| Secret name | Description |
|-------------|-------------|
| `paytech-db-password` | Cloud SQL postgres user password |
| `paytech-rabbitmq-url` | Full AMQPS connection string for CloudAMQP |
| `paytech-api-keys` | Comma-separated valid API keys for the gateway |

---

## Environment variables

Every service documents its variables in `.env.example`. The full list:

| Variable | Services | Description |
|----------|----------|-------------|
| `PORT` | all | HTTP listen port |
| `LOG_LEVEL` | all | `trace` \| `debug` \| `info` \| `warn` \| `error` |
| `POSTGRES_HOST` | all except fraud | DB host or Cloud SQL socket path |
| `POSTGRES_PORT` | all except fraud | Default `5432` |
| `POSTGRES_DB` | all except fraud | Default `paytech` |
| `POSTGRES_USER` | all except fraud | DB user |
| `POSTGRES_PASSWORD` | all except fraud | Inject from Secret Manager |
| `PG_POOL_MAX` | all except fraud | Connection pool size, default `10` |
| `RABBITMQ_URL` | payment, order, notification | Full AMQP(S) connection string |
| `FRAUD_SERVICE_URL` | payment | Internal URL of fraud-service |
| `LEDGER_SERVICE_URL` | payment | Internal URL of ledger-service |
| `FRAUD_FAIL_OPEN` | payment | `false` = reject when fraud-service is down |
| `SIMULATE_SEND_FAILURE` | notification | `0`–`1` probability of simulated failure |

---

## API reference

### Authentication

All requests through the gateway require:
```
X-Api-Key: <key>
```

The gateway injects `X-Authenticated-User-Id` into downstream requests — services trust this header and do not re-authenticate.

### Endpoints

```
POST   /api/payments          Create a payment (requires Idempotency-Key header)
GET    /api/payments/:id      Get payment by id
GET    /api/payments          List payments

POST   /api/orders            Create an order
GET    /api/orders/:id        Get order by id
GET    /api/orders            List orders
PATCH  /api/orders/:id/cancel Cancel a pending order

GET    /api/users/:id         Get user by id
GET    /api/users             List users

GET    /api/notifications     List notification log
GET    /api/notifications/:eventId
```

### POST /api/payments

```http
POST /api/payments
X-Api-Key: your-key
Idempotency-Key: <unique-string-per-payment-attempt>
Content-Type: application/json

{
  "amount":   99.99,
  "currency": "USD",
  "orderId":  "optional-order-uuid",
  "metadata": {}
}
```

The `Idempotency-Key` header is required. The same key always returns the same response with no side effects — the customer is charged at most once regardless of retries. Replayed responses include the header `Idempotent-Replayed: true`.

---

## Distributed-systems guarantees

### Idempotency (payment-service)

```
First request    → INSERT idempotency_keys + run pipeline (atomic)
Retry request    → SELECT idempotency_keys → return cached response
Concurrent dup   → PK constraint on idempotency_keys serialises both requests
Mid-flight crash → transaction rollback, key not stored, safe to retry
```

### Transactional outbox (payment-service)

```
DB transaction:
  UPDATE payments SET status='succeeded'
  INSERT outbox_events (same transaction, atomically)

Outbox relay:
  SELECT outbox_events WHERE published=FALSE FOR UPDATE SKIP LOCKED
  publish to RabbitMQ
  UPDATE outbox_events SET published=TRUE

Guarantee: if the transaction commits, the event is eventually published.
Broker downtime accumulates events in the DB, not in memory.
```

### At-least-once consumers (order-service, notification-service)

Both consumers are idempotent:

- **order-service**: `UPDATE orders SET status='paid' WHERE id=$1 AND status='pending'` — replays are no-ops once the order is paid.
- **notification-service**: `INSERT INTO notification_log ON CONFLICT DO NOTHING` — second delivery of the same event skips send entirely.

### Double-entry ledger (ledger-service)

Every charge writes two rows that net to zero:
```
DEBIT  customer_account  (money leaves)
CREDIT revenue_account   (money arrives)
```
Protected by `UNIQUE (idempotency_key, account_id, direction)` — replay-safe across retries.

---

## Database migrations

Migrations live in `infra/postgres/migrations/` and are run by `infra/postgres/migrate.js`.

All migrations are idempotent (`IF NOT EXISTS`, `ON CONFLICT DO NOTHING`) — safe to re-run on every deployment.

| File | Contents |
|------|----------|
| `001_users.sql` | users table, seed data |
| `002_payments.sql` | payments + idempotency_keys tables |
| `003_orders.sql` | orders table |
| `004_ledger.sql` | ledger_accounts + ledger_entries (double-entry) |
| `005_outbox.sql` | outbox_events (transactional outbox) |
| `006_notification_log.sql` | notification_log (consumer deduplication) |
