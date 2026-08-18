export const MESSAGE_NOTIFICATION_CHANNEL = 'chat_message_committed';

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS users (
  id varchar(64) PRIMARY KEY,
  status varchar(16) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'deleted')),
  created_at_ms bigint NOT NULL CHECK (created_at_ms >= 0)
);

CREATE TABLE IF NOT EXISTS devices (
  user_id varchar(64) NOT NULL REFERENCES users(id),
  device_id varchar(64) NOT NULL,
  status varchar(16) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  created_at_ms bigint NOT NULL CHECK (created_at_ms >= 0),
  PRIMARY KEY (user_id, device_id)
);

CREATE TABLE IF NOT EXISTS conversations (
  id uuid PRIMARY KEY,
  kind varchar(16) NOT NULL CHECK (kind IN ('direct', 'group')),
  owner_id varchar(64) NOT NULL REFERENCES users(id),
  idempotency_key varchar(128) NOT NULL,
  request_digest char(64) NOT NULL,
  max_members integer NOT NULL CHECK (max_members BETWEEN 2 AND 20),
  last_sequence bigint NOT NULL DEFAULT 0 CHECK (last_sequence >= 0),
  created_at_ms bigint NOT NULL CHECK (created_at_ms >= 0),
  CONSTRAINT conversations_owner_key_uniq UNIQUE (owner_id, idempotency_key)
);

CREATE TABLE IF NOT EXISTS conversation_memberships (
  conversation_id uuid NOT NULL REFERENCES conversations(id),
  user_id varchar(64) NOT NULL REFERENCES users(id),
  generation bigint NOT NULL CHECK (generation > 0),
  role varchar(16) NOT NULL CHECK (role IN ('owner', 'member')),
  join_after_sequence bigint NOT NULL CHECK (join_after_sequence >= 0),
  leave_after_sequence bigint,
  joined_at_ms bigint NOT NULL CHECK (joined_at_ms >= 0),
  left_at_ms bigint,
  PRIMARY KEY (conversation_id, user_id, generation),
  CONSTRAINT conversation_membership_interval CHECK (
    (leave_after_sequence IS NULL AND left_at_ms IS NULL)
    OR (
      leave_after_sequence IS NOT NULL
      AND left_at_ms IS NOT NULL
      AND leave_after_sequence >= join_after_sequence
      AND left_at_ms >= joined_at_ms
    )
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS conversation_memberships_one_active_idx
  ON conversation_memberships (conversation_id, user_id)
  WHERE leave_after_sequence IS NULL;

CREATE INDEX IF NOT EXISTS conversation_memberships_user_idx
  ON conversation_memberships (user_id, conversation_id, join_after_sequence, leave_after_sequence);

CREATE TABLE IF NOT EXISTS messages (
  id uuid PRIMARY KEY,
  conversation_id uuid NOT NULL REFERENCES conversations(id),
  sequence bigint NOT NULL CHECK (sequence > 0),
  sender_id varchar(64) NOT NULL REFERENCES users(id),
  sender_membership_generation bigint NOT NULL CHECK (sender_membership_generation > 0),
  client_message_id varchar(128) NOT NULL,
  request_digest char(64) NOT NULL,
  content text NOT NULL CHECK (octet_length(content) BETWEEN 1 AND 4096),
  accepted_at_ms bigint NOT NULL CHECK (accepted_at_ms >= 0),
  CONSTRAINT messages_conversation_sequence_uniq UNIQUE (conversation_id, sequence),
  CONSTRAINT messages_sender_client_uniq UNIQUE (sender_id, client_message_id),
  FOREIGN KEY (conversation_id, sender_id, sender_membership_generation)
    REFERENCES conversation_memberships(conversation_id, user_id, generation)
);

CREATE INDEX IF NOT EXISTS messages_conversation_sync_idx
  ON messages (conversation_id, sequence);

CREATE TABLE IF NOT EXISTS realtime_tickets (
  ticket_hash char(64) PRIMARY KEY,
  user_id varchar(64) NOT NULL,
  device_id varchar(64) NOT NULL,
  created_at_ms bigint NOT NULL CHECK (created_at_ms >= 0),
  expires_at_ms bigint NOT NULL CHECK (expires_at_ms > created_at_ms),
  consumed_at_ms bigint,
  FOREIGN KEY (user_id, device_id) REFERENCES devices(user_id, device_id),
  CONSTRAINT realtime_ticket_consumed_time CHECK (
    consumed_at_ms IS NULL OR consumed_at_ms >= created_at_ms
  )
);

CREATE INDEX IF NOT EXISTS realtime_tickets_expiry_idx
  ON realtime_tickets (expires_at_ms)
  WHERE consumed_at_ms IS NULL;

CREATE TABLE IF NOT EXISTS device_progress (
  user_id varchar(64) NOT NULL,
  device_id varchar(64) NOT NULL,
  conversation_id uuid NOT NULL REFERENCES conversations(id),
  synced_through bigint NOT NULL DEFAULT 0 CHECK (synced_through >= 0),
  read_claimed_through bigint NOT NULL DEFAULT 0 CHECK (
    read_claimed_through >= 0 AND read_claimed_through <= synced_through
  ),
  updated_at_ms bigint NOT NULL CHECK (updated_at_ms >= 0),
  PRIMARY KEY (user_id, device_id, conversation_id),
  FOREIGN KEY (user_id, device_id) REFERENCES devices(user_id, device_id)
);
`;
