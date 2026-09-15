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
├── cloudbuild.yaml               # GCP Cloud Build CI/CD
├── buildspec.yml                 # AWS CodeBuild CI/CD
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
- `Dockerfile` — multi-stage build, build context is repo root
- `.env.example` — all required environment variables documented

---

## Deploying to GCP

### Managed services used

| Concern | GCP service |
|---------|-------------|
| Container runtime | Cloud Run |
| Database | Cloud SQL (PostgreSQL 16) |
| Message broker | CloudAMQP (managed RabbitMQ) or Google Cloud Pub/Sub |
| Container registry | Artifact Registry |
| Secrets | Secret Manager |
| CI/CD | Cloud Build (`cloudbuild.yaml`) |

### One-time setup

```bash
export PROJECT_ID=your-project-id
export REGION=europe-west1

# Enable required APIs
gcloud services enable \
  run.googleapis.com \
  sqladmin.googleapis.com \
  artifactregistry.googleapis.com \
  cloudbuild.googleapis.com \
  secretmanager.googleapis.com \
  --project=$PROJECT_ID

# Create Artifact Registry repository
gcloud artifacts repositories create paytech \
  --repository-format=docker \
  --location=$REGION \
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

# Store secrets
echo -n "<strong-password>" | \
  gcloud secrets create paytech-db-password \
    --data-file=- --project=$PROJECT_ID

echo -n "amqps://user:pass@host/vhost" | \
  gcloud secrets create paytech-rabbitmq-url \
    --data-file=- --project=$PROJECT_ID

echo -n "key-one,key-two" | \
  gcloud secrets create paytech-api-keys \
    --data-file=- --project=$PROJECT_ID

# Create a dedicated service account for Cloud Run services
gcloud iam service-accounts create paytech-run \
  --display-name="PayTech Cloud Run SA" \
  --project=$PROJECT_ID

# Grant it access to Cloud SQL, Secret Manager, and Artifact Registry
for role in \
  roles/cloudsql.client \
  roles/secretmanager.secretAccessor \
  roles/artifactregistry.reader; do
  gcloud projects add-iam-policy-binding $PROJECT_ID \
    --member="serviceAccount:paytech-run@$PROJECT_ID.iam.gserviceaccount.com" \
    --role="$role"
done
```

### Connect Cloud Build trigger

```bash
# Grant Cloud Build permission to deploy Cloud Run and read secrets
for role in \
  roles/run.admin \
  roles/iam.serviceAccountUser \
  roles/artifactregistry.writer \
  roles/secretmanager.secretAccessor; do
  gcloud projects add-iam-policy-binding $PROJECT_ID \
    --member="serviceAccount:$(gcloud projects describe $PROJECT_ID \
      --format='value(projectNumber)')@cloudbuild.gserviceaccount.com" \
    --role="$role"
done

# Create trigger pointing at your repo
gcloud builds triggers create github \
  --repo-name=paytech \
  --repo-owner=<your-github-org> \
  --branch-pattern="^main$" \
  --build-config=cloudbuild.yaml \
  --substitutions=\
_REGION=$REGION,\
_REGISTRY=$REGION-docker.pkg.dev/$PROJECT_ID/paytech,\
_CLOUDSQL_CONN=$PROJECT_ID:$REGION:paytech-pg,\
_RUN_SA=paytech-run@$PROJECT_ID.iam.gserviceaccount.com \
  --project=$PROJECT_ID
```

### Run migrations manually (first deploy)

```bash
gcloud run jobs create paytech-migrate \
  --image=$REGION-docker.pkg.dev/$PROJECT_ID/paytech/user-service:latest \
  --region=$REGION \
  --service-account=paytech-run@$PROJECT_ID.iam.gserviceaccount.com \
  --add-cloudsql-instances=$PROJECT_ID:$REGION:paytech-pg \
  --set-secrets=POSTGRES_PASSWORD=paytech-db-password:latest \
  --set-env-vars="POSTGRES_HOST=/cloudsql/$PROJECT_ID:$REGION:paytech-pg,\
POSTGRES_DB=paytech,POSTGRES_USER=paytech" \
  --command=node \
  --args="infra/postgres/migrate.js" \
  --execute-now \
  --wait \
  --project=$PROJECT_ID
```

### POSTGRES_HOST for Cloud SQL

Cloud Run connects to Cloud SQL via a Unix socket. Set:
```
POSTGRES_HOST=/cloudsql/<project>:<region>:<instance>
```
The Cloud SQL Auth Proxy is built into Cloud Run — no sidecar needed.

---

## Deploying to AWS

### Managed services used

| Concern | AWS service |
|---------|-------------|
| Container runtime | ECS Fargate |
| Database | RDS PostgreSQL 16 |
| Message broker | Amazon MQ (RabbitMQ) |
| Container registry | ECR |
| Secrets | SSM Parameter Store (SecureString) |
| CI/CD | CodeBuild (`buildspec.yml`) |

### One-time setup

```bash
export AWS_REGION=eu-west-1
export AWS_ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
export ECR_BASE=$AWS_ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com/paytech

# Create ECR repositories
for svc in api-gateway user-service payment-service order-service \
           notification-service fraud-service ledger-service; do
  aws ecr create-repository --repository-name paytech/$svc --region $AWS_REGION
done

# Create RDS PostgreSQL instance
aws rds create-db-instance \
  --db-instance-identifier paytech-pg \
  --db-instance-class db.t3.micro \
  --engine postgres \
  --engine-version 16 \
  --master-username paytech \
  --master-user-password <strong-password> \
  --db-name paytech \
  --allocated-storage 20 \
  --no-publicly-accessible \
  --region $AWS_REGION

# Create Amazon MQ RabbitMQ broker
aws mq create-broker \
  --broker-name paytech-rabbit \
  --engine-type RABBITMQ \
  --engine-version 3.13 \
  --host-instance-type mq.m5.large \
  --deployment-mode SINGLE_INSTANCE \
  --publicly-accessible \
  --user Username=paytech,Password=<strong-password> \
  --region $AWS_REGION

# Store secrets in SSM Parameter Store
aws ssm put-parameter --name /paytech/db/password \
  --value "<strong-password>" --type SecureString --region $AWS_REGION

aws ssm put-parameter --name /paytech/rabbitmq/url \
  --value "amqps://paytech:<pass>@<broker-endpoint>:5671/paytech" \
  --type SecureString --region $AWS_REGION

aws ssm put-parameter --name /paytech/api/keys \
  --value "key-one,key-two" --type SecureString --region $AWS_REGION
```

### ECS cluster and services

Use the AWS CDK, Terraform, or the console to create:
- ECS cluster: `paytech-cluster`
- One Fargate service per service: `paytech-<service-name>`
- Task definitions referencing the ECR images
- A service-linked IAM role with SSM read access

The `buildspec.yml` then handles updating task definitions and triggering rolling deployments on every push to `main`.

### Run migrations (first deploy)

```bash
# Build and push the user-service image first, then run:
aws ecs run-task \
  --cluster paytech-cluster \
  --task-definition paytech-migrate \
  --launch-type FARGATE \
  --overrides '{
    "containerOverrides": [{
      "name": "migrate",
      "command": ["node", "infra/postgres/migrate.js"]
    }]
  }' \
  --network-configuration "awsvpcConfiguration={
    subnets=[subnet-xxxx],
    securityGroups=[sg-xxxx],
    assignPublicIp=DISABLED
  }" \
  --region $AWS_REGION
```

### POSTGRES_HOST for RDS

Use the RDS endpoint hostname directly:
```
POSTGRES_HOST=paytech-pg.xxxxxxxxx.eu-west-1.rds.amazonaws.com
```
Ensure the ECS task security group has outbound access to the RDS security group on port 5432.

---

## Secrets management

Never put real credentials in environment variables directly or in source control. Both pipelines are wired to pull from the respective secrets store at deploy time.

| Secret name | GCP Secret Manager | AWS SSM Parameter Store |
|-------------|-------------------|------------------------|
| DB password | `paytech-db-password` | `/paytech/db/password` |
| RabbitMQ URL | `paytech-rabbitmq-url` | `/paytech/rabbitmq/url` |
| API keys | `paytech-api-keys` | `/paytech/api/keys` |

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
| `POSTGRES_PASSWORD` | all except fraud | Inject from secrets store |
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
First request  → INSERT idempotency_keys + run pipeline (atomic)
Retry request  → SELECT idempotency_keys → return cached response
Concurrent dup → PK constraint on idempotency_keys serialises both requests
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
