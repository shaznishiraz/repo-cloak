import { Placeholder } from '../../shell/placeholder.js';

export function ProfilesScreen({
  profileId,
  json,
}: {
  profileId?: string | undefined;
  json?: boolean | undefined;
}) {
  return (
    <Placeholder
      title="Profiles"
      package="40-profiles"
      detail={profileId && `${profileId}${json ? ' (JSON)' : ''}`}
    />
  );
}
