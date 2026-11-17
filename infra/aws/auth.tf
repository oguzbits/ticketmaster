resource "aws_cognito_user_pool" "main" {
  name                = "${var.project_name}-${var.environment}-users"
  deletion_protection = "ACTIVE"

  username_attributes      = ["email"]
  auto_verified_attributes = ["email"]

  password_policy {
    minimum_length                   = 12
    require_lowercase                = true
    require_numbers                  = true
    require_symbols                  = true
    require_uppercase                = true
    temporary_password_validity_days = 7
  }

  account_recovery_setting {
    recovery_mechanism {
      name     = "verified_email"
      priority = 1
    }
  }
}

resource "aws_cognito_user_group" "roles" {
  for_each     = toset(["customer", "organizer", "admin"])
  name         = each.key
  user_pool_id = aws_cognito_user_pool.main.id
  description  = "Application RBAC role matching ROLE.${upper(each.key)}."
}

resource "aws_cognito_user_pool_client" "web" {
  name         = "${var.project_name}-${var.environment}-web"
  user_pool_id = aws_cognito_user_pool.main.id

  generate_secret                      = true
  allowed_oauth_flows_user_pool_client = true
  allowed_oauth_flows                  = ["code"]
  allowed_oauth_scopes                 = ["openid", "email", "profile"]
  supported_identity_providers         = ["COGNITO"]

  callback_urls = ["https://${var.domain_name}/auth/callback"]
  logout_urls   = ["https://${var.domain_name}/"]
}
