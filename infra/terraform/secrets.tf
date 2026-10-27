locals {
  secret_names = toset(concat(
    ["SESSION_SECRET", "ISMS_MASTER_KEY", "DATABASE_URL"],
    var.app_secret_names,
  ))

  secret_descriptions = {
    SESSION_SECRET  = "Express session signing secret (at least 32 characters)."
    ISMS_MASTER_KEY = "Field-encryption master key (64+ hex characters). Losing or changing it makes encrypted data unreadable."
    DATABASE_URL    = "PostgreSQL connection string for the app (RDS, TLS verified against the CA bundle in the image)."
  }
}

resource "aws_secretsmanager_secret" "app" {
  # checkov:skip=CKV2_AWS_57:No rotation Lambda can rotate these safely: ISMS_MASTER_KEY must never be replaced (data would become unreadable), SESSION_SECRET rotation signs everyone out, provider API keys rotate at the provider, and DATABASE_URL rotates through db_password_version. Rotation is a runbook procedure (deploy/AWS.md).
  for_each = local.secret_names

  name                    = "${local.name}/${each.key}"
  description             = lookup(local.secret_descriptions, each.key, "Runtime secret ${each.key} for ${local.name}.")
  kms_key_id              = aws_kms_key.app.arn
  recovery_window_in_days = var.secret_recovery_window_days
}
