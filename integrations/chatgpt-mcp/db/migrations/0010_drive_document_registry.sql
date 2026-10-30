BEGIN;

-- Folder discovery is maintenance-only. Existing problem/source IDs and history stay immutable.
CREATE TABLE document_folders (
  folder_id text PRIMARY KEY,
  subject_id text NOT NULL REFERENCES subjects(subject_id),
  stage exam_stage NOT NULL,
  title text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (subject_id, stage, folder_id)
);

CREATE TABLE document_registry (
  document_id text PRIMARY KEY REFERENCES source_documents(document_id) ON DELETE RESTRICT,
  source_id text NOT NULL UNIQUE,
  subject_id text NOT NULL REFERENCES subjects(subject_id),
  stage exam_stage NOT NULL,
  folder_id text REFERENCES document_folders(folder_id),
  title text NOT NULL,
  registration_kind text NOT NULL CHECK (registration_kind IN ('EXTERNAL', 'FOLDER')),
  registration_status text NOT NULL DEFAULT 'DISCOVERED'
    CHECK (registration_status IN ('DISCOVERED','STAGED','READY','REVIEW','ERROR')),
  current_revision_id text,
  last_synced_drive_version text,
  last_seen_at timestamptz,
  last_synced_at timestamptz,
  parsed_problem_count integer NOT NULL DEFAULT 0 CHECK (parsed_problem_count >= 0),
  last_counts jsonb NOT NULL DEFAULT '{}'::jsonb,
  failure_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((registration_kind = 'EXTERNAL' AND folder_id IS NULL) OR
         (registration_kind = 'FOLDER' AND folder_id IS NOT NULL))
);

CREATE TABLE document_registry_events (
  event_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  document_id text NOT NULL REFERENCES document_registry(document_id) ON DELETE RESTRICT,
  event_kind text NOT NULL CHECK (event_kind IN
    ('REGISTERED','SEEN','SYNCED','FAILED','MOVE_REVIEW','MISSING_REVIEW')),
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX document_registry_folder_idx ON document_registry(folder_id, registration_status);
CREATE INDEX document_registry_subject_stage_idx ON document_registry(subject_id, stage, registration_status);

INSERT INTO document_folders(folder_id,subject_id,stage,title) VALUES
  ('1z17WoYz5pAo--l3EBpdE1AeTV6sQALl1','CIVIL','P1','1차'),
  ('1AEZaBXBYXJHnzWblaWMfEPET3LXT80Bs','CIVIL','P2','2차');

INSERT INTO source_documents(document_id,subject_id,title,read_only) VALUES
  ('169rzZ3qlM-LfZI7I6gCSwWEeJ4Cc8RiHZzH9Qm_dwys','CIVIL','민법 1차 지문 OX_1편',true),
  ('1hEQNsDti70lCSYG5PL90s7klhpqQJ-V4kERpSocuLLc','CIVIL','민법 1차 지문 OX_2편',true),
  ('1xP0jLOUUQWzUGrv0whx7_z1cyVWAghxlGJVQo3Do_xA','CIVIL','민법 사례 2차',true)
ON CONFLICT(document_id) DO NOTHING;

INSERT INTO document_registry(document_id,source_id,subject_id,stage,title,registration_kind,
                              registration_status,current_revision_id,last_synced_at)
SELECT v.document_id,v.source_id,'CIVIL',v.stage,d.title,'EXTERNAL','READY',
       d.current_revision_id,d.last_checked_at
FROM (VALUES
  ('169rzZ3qlM-LfZI7I6gCSwWEeJ4Cc8RiHZzH9Qm_dwys','SRC-CIV-004','P1'::exam_stage),
  ('1hEQNsDti70lCSYG5PL90s7klhpqQJ-V4kERpSocuLLc','SRC-CIV-004B','P1'::exam_stage),
  ('1xP0jLOUUQWzUGrv0whx7_z1cyVWAghxlGJVQo3Do_xA','SRC-CIV-005','P2'::exam_stage)
) AS v(document_id,source_id,stage)
JOIN source_documents d ON d.document_id=v.document_id
ON CONFLICT(document_id) DO NOTHING;

COMMIT;
