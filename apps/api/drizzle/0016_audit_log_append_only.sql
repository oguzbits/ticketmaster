-- Defense in depth: the runtime role cannot update or delete audit rows, and a trigger stops the owner too.
REVOKE UPDATE, DELETE ON TABLE "audit_log" FROM app_runtime;--> statement-breakpoint
CREATE OR REPLACE FUNCTION "prevent_audit_log_mutation"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only: % is forbidden', TG_OP USING ERRCODE = '42501';
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER "audit_log_append_only"
  BEFORE UPDATE OR DELETE ON "audit_log"
  FOR EACH ROW
  EXECUTE FUNCTION "prevent_audit_log_mutation"();