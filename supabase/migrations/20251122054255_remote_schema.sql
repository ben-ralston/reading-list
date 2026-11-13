


SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;


COMMENT ON SCHEMA "public" IS 'standard public schema';



CREATE EXTENSION IF NOT EXISTS "pg_graphql" WITH SCHEMA "graphql";






CREATE EXTENSION IF NOT EXISTS "pg_stat_statements" WITH SCHEMA "extensions";






CREATE EXTENSION IF NOT EXISTS "pgcrypto" WITH SCHEMA "extensions";






CREATE EXTENSION IF NOT EXISTS "supabase_vault" WITH SCHEMA "vault";






CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA "extensions";






CREATE OR REPLACE FUNCTION "public"."batch_update_queue"("updates" "jsonb") RETURNS "void"
    LANGUAGE "plpgsql"
    AS $$
DECLARE
  update_item jsonb;
  item_id integer;
BEGIN
  -- Iterate through each update in the array
  FOR update_item IN SELECT * FROM jsonb_array_elements(updates)
  LOOP
    -- Extract ID
    item_id := (update_item->>'id')::integer;

    -- Build and execute dynamic UPDATE statement based on provided fields
    -- This allows partial updates (only update fields that are present in JSON)
    UPDATE queue_items
    SET
      status = COALESCE(
        CASE WHEN update_item ? 'status'
          THEN (update_item->>'status')::text
          ELSE NULL
        END,
        status
      ),
      queue_position = CASE
        WHEN update_item ? 'queue_position' THEN
          CASE
            WHEN update_item->>'queue_position' = 'null' THEN NULL
            ELSE (update_item->>'queue_position')::integer
          END
        ELSE queue_position
      END,
      position_confirmed = COALESCE(
        CASE WHEN update_item ? 'position_confirmed'
          THEN (update_item->>'position_confirmed')::boolean
          ELSE NULL
        END,
        position_confirmed
      )
    WHERE id = item_id;
  END LOOP;
END;
$$;


ALTER FUNCTION "public"."batch_update_queue"("updates" "jsonb") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."batch_update_queue"("updates" "jsonb") IS 'Batch update multiple queue items in single transaction for performance. Accepts JSONB array of updates with optional fields: status, queue_position, position_confirmed. Used by handleMakeNext to reduce 15-20+ requests to 1 request.';



CREATE OR REPLACE FUNCTION "public"."update_updated_at_column"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."update_updated_at_column"() OWNER TO "postgres";

SET default_tablespace = '';

SET default_table_access_method = "heap";


CREATE TABLE IF NOT EXISTS "public"."queue_items" (
    "id" bigint NOT NULL,
    "title" "text" NOT NULL,
    "author" "text" NOT NULL,
    "platform" "text" NOT NULL,
    "link" "text",
    "published_on" timestamp with time zone DEFAULT "now"(),
    "status" "text" DEFAULT ''::"text",
    "progress" "text",
    "message_id" "text",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "queue_position" bigint,
    "position_confirmed" boolean DEFAULT false NOT NULL,
    CONSTRAINT "completed_skip_no_position" CHECK ((("status" <> ALL (ARRAY['Completed'::"text", 'Skip'::"text"])) OR ("queue_position" IS NULL))),
    CONSTRAINT "valid_status_values" CHECK (("status" = ANY (ARRAY[''::"text", 'In Progress'::"text", 'Completed'::"text", 'Skip'::"text"])))
);


ALTER TABLE "public"."queue_items" OWNER TO "postgres";


COMMENT ON COLUMN "public"."queue_items"."progress" IS 'Progress tracking for content consumption (e.g., "45 min left", "25% complete")';



COMMENT ON COLUMN "public"."queue_items"."queue_position" IS 'Manual queue ordering - lower values = higher priority. NULL = use automatic sort.';



CREATE SEQUENCE IF NOT EXISTS "public"."queue_items_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."queue_items_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."queue_items_id_seq" OWNED BY "public"."queue_items"."id";



ALTER TABLE ONLY "public"."queue_items" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."queue_items_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."queue_items"
    ADD CONSTRAINT "queue_items_message_id_key" UNIQUE ("message_id");



ALTER TABLE ONLY "public"."queue_items"
    ADD CONSTRAINT "queue_items_pkey" PRIMARY KEY ("id");



CREATE INDEX "idx_message_id" ON "public"."queue_items" USING "btree" ("message_id");



CREATE OR REPLACE TRIGGER "update_queue_items_updated_at" BEFORE UPDATE ON "public"."queue_items" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();



CREATE POLICY "Allow all operations with service key" ON "public"."queue_items" USING (true);



ALTER TABLE "public"."queue_items" ENABLE ROW LEVEL SECURITY;




ALTER PUBLICATION "supabase_realtime" OWNER TO "postgres";


GRANT USAGE ON SCHEMA "public" TO "postgres";
GRANT USAGE ON SCHEMA "public" TO "anon";
GRANT USAGE ON SCHEMA "public" TO "authenticated";
GRANT USAGE ON SCHEMA "public" TO "service_role";

























































































































































GRANT ALL ON FUNCTION "public"."batch_update_queue"("updates" "jsonb") TO "anon";
GRANT ALL ON FUNCTION "public"."batch_update_queue"("updates" "jsonb") TO "authenticated";
GRANT ALL ON FUNCTION "public"."batch_update_queue"("updates" "jsonb") TO "service_role";



GRANT ALL ON FUNCTION "public"."update_updated_at_column"() TO "anon";
GRANT ALL ON FUNCTION "public"."update_updated_at_column"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."update_updated_at_column"() TO "service_role";


















GRANT ALL ON TABLE "public"."queue_items" TO "anon";
GRANT ALL ON TABLE "public"."queue_items" TO "authenticated";
GRANT ALL ON TABLE "public"."queue_items" TO "service_role";



GRANT ALL ON SEQUENCE "public"."queue_items_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."queue_items_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."queue_items_id_seq" TO "service_role";









ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "service_role";






ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "service_role";






ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "service_role";































