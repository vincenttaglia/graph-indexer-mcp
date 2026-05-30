import type { Config } from '../config.js';
import type { Authorizer } from './authorizer.js';

/**
 * Build the Kubernetes-RBAC authorizer.
 *
 * TODO(stage2-C): TokenReview + SubjectAccessReview against in-cluster apiserver
 * via fetch, with caching.
 *
 * Expected behavior (per plan Phase 4):
 *   - `authorize(ctx, permissionClass, toolName)`:
 *       1. No `ctx.identity?.token` → return false (fail-closed).
 *       2. TokenReview: POST /apis/authentication.k8s.io/v1/tokenreviews with the
 *          bearer token (and `config.k8sApiAudience` as `spec.audiences` when set).
 *          On `status.authenticated === false` → false. Cache by token (~30s TTL).
 *       3. SubjectAccessReview: POST
 *          /apis/authorization.k8s.io/v1/subjectaccessreviews with the resolved
 *          user/groups and the SAR attributes below. Return `status.allowed`.
 *          Cache by `user|verb` (~10s TTL).
 *
 *   SAR resourceAttributes:
 *     - apiGroup (group): 'mcp.thegraph.io'
 *     - resource:         'tools'
 *     - verb:             <permissionClass>   (e.g. 'read', 'agent_queue', …)
 *
 *   - API access: call the in-cluster apiserver directly via global `fetch`
 *     (Node 22) using KUBERNETES_SERVICE_HOST/PORT, the mounted SA token at
 *     /var/run/secrets/kubernetes.io/serviceaccount/token, and the cluster CA at
 *     /var/run/secrets/kubernetes.io/serviceaccount/ca.crt. No
 *     `@kubernetes/client-node` dependency.
 *   - `init()`: trivial self-SAR to confirm the pod's SA has
 *     `system:auth-delegator`; log a clear error and fail readiness if not.
 *   - Fail-closed: any apiserver error → deny (one stderr warn), never allow.
 */
export async function makeK8sRbacAuthorizer(_config: Config): Promise<Authorizer> {
  throw new Error('k8s-rbac authorizer not implemented yet');
}
