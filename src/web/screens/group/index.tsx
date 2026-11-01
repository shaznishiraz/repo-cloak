import { Placeholder } from '../../shell/placeholder.js';

export function GroupScreen({ groupId }: { groupId: string }) {
  return <Placeholder title="Group sync" package="10-home" detail={groupId} />;
}
