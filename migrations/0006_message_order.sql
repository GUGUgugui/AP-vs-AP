ALTER TABLE messages ADD COLUMN message_index INTEGER NOT NULL DEFAULT 0;
WITH positions AS (
  SELECT id, ROW_NUMBER() OVER(PARTITION BY match_id ORDER BY created_at,id)-1 AS position FROM messages
)
UPDATE messages SET message_index=(SELECT position FROM positions WHERE positions.id=messages.id);
