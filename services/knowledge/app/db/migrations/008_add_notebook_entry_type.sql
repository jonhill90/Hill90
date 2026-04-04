-- Add 'notebook' to knowledge_entries entry_type constraint
ALTER TABLE knowledge_entries DROP CONSTRAINT IF EXISTS knowledge_entries_entry_type_check;
ALTER TABLE knowledge_entries ADD CONSTRAINT knowledge_entries_entry_type_check
    CHECK (entry_type IN ('plan', 'decision', 'journal', 'research', 'context', 'note', 'notebook'));
