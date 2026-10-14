CREATE TABLE "credentials" (
	"id" text PRIMARY KEY NOT NULL,
	"token_hash" text NOT NULL,
	"user_id" text NOT NULL,
	"username" text NOT NULL,
	"role" text NOT NULL,
	"issued_by" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "credentials_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" text PRIMARY KEY NOT NULL,
	"username" text NOT NULL,
	"password_hash" text NOT NULL,
	"role" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "users_username_unique" UNIQUE("username")
);
--> statement-breakpoint
CREATE INDEX "credentials_token_hash_idx" ON "credentials" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "credentials_user_id_idx" ON "credentials" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "credentials_expires_at_idx" ON "credentials" USING btree ("expires_at");