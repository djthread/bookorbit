CREATE TABLE "sync_target_collections" (
	"sync_target_id" integer NOT NULL,
	"collection_id" integer NOT NULL,
	CONSTRAINT "sync_target_collections_sync_target_id_collection_id_pk" PRIMARY KEY("sync_target_id","collection_id")
);
--> statement-breakpoint
CREATE TABLE "sync_targets" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"name" text NOT NULL,
	"syncthing_folder_id" text NOT NULL,
	"export_path" text NOT NULL,
	"device_id" text,
	"mode" text DEFAULT 'sendonly' NOT NULL,
	"status" text DEFAULT 'idle' NOT NULL,
	"last_completion" integer,
	"last_synced_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "sync_target_collections" ADD CONSTRAINT "sync_target_collections_sync_target_id_sync_targets_id_fk" FOREIGN KEY ("sync_target_id") REFERENCES "public"."sync_targets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_target_collections" ADD CONSTRAINT "sync_target_collections_collection_id_collections_id_fk" FOREIGN KEY ("collection_id") REFERENCES "public"."collections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_targets" ADD CONSTRAINT "sync_targets_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sync_target_collections_collection_id_idx" ON "sync_target_collections" USING btree ("collection_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sync_targets_user_name_uidx" ON "sync_targets" USING btree ("user_id","name");