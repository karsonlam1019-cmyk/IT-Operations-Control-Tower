-- Repair automatic Deputy Head of IT activation for existing databases.
-- The deputy relationship is stored on the deputy profile, pointing to the
-- Head of IT profile, so activation must resolve the relationship in reverse.

CREATE OR REPLACE FUNCTION activate_deputy_on_leave()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  linked_deputy_id UUID;
BEGIN
  IF NEW.role <> 'SUPER_ADMIN' THEN
    RETURN NEW;
  END IF;

  SELECT id INTO linked_deputy_id
    FROM profiles
   WHERE deputy_for_user_id = NEW.id
     AND role = 'DEPUTY_HEAD_OF_IT'
     AND COALESCE(on_leave, FALSE) = FALSE
   ORDER BY created_at
   LIMIT 1;

  IF NEW.on_leave = TRUE AND OLD.on_leave = FALSE AND linked_deputy_id IS NOT NULL THEN
    INSERT INTO audit_logs (actor_id, action_type, target_resource, new_value, acted_as_deputy)
    VALUES (
      linked_deputy_id,
      'DEPUTY_ACTIVATED',
      'Head of IT role',
      jsonb_build_object('deputy', linked_deputy_id),
      TRUE
    );
  ELSIF NEW.on_leave = FALSE AND OLD.on_leave = TRUE AND linked_deputy_id IS NOT NULL THEN
    INSERT INTO audit_logs (actor_id, action_type, target_resource, new_value, acted_as_deputy)
    VALUES (
      NEW.id,
      'DEPUTY_DEACTIVATED',
      'Head of IT role',
      jsonb_build_object('deputy', linked_deputy_id),
      FALSE
    );
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_deputy_on_leave ON profiles;
CREATE TRIGGER trg_deputy_on_leave
AFTER UPDATE OF on_leave ON profiles
FOR EACH ROW EXECUTE FUNCTION activate_deputy_on_leave();