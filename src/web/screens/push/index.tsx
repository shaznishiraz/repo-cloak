import { Placeholder } from '../../shell/placeholder.js';

export function PushScreen({ workspaceId }: { workspaceId: string }) {
  return <Placeholder title="Push review" package="30-push" detail={workspaceId} />;
}
