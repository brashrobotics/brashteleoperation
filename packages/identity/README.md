# Identity and Authorization

Defines operator/service principals, a least-privilege role matrix, permission
checks, and binding between authenticated identity and operator/robot IDs
carried in domain contracts. The control API resolves a principal per request
through `RequestIdentityProvider`; when supplied, actor binding is enforced.
The same abstraction gives operator roles the low-rate `media:read` permission;
the media gateway still requires an application callback to authorize the
specific immutable observation before issuing a scoped grant.

Robot-owned assistance machine transitions are deliberately absent from every
human role, including supervisor and administrator. The API also rechecks the
exact request robot ID, so administrative breadth cannot impersonate robot
perception, planning, execution, or verification output.

`StaticBearerIdentityProvider` is bounded to 64 loopback development
credentials, retains token digests rather than raw tokens, performs fixed-size
constant-time comparisons, and permits distinct least-privilege operator and
robot principals on one listener. It is not a production identity provider;
production must replace it with verified OIDC and workload/mTLS credentials
before non-loopback ingress is permitted.
