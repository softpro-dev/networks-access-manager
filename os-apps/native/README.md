# native/

No native component is included in this build.

Network enforcement (the enforcement plane) is out of scope for this release. The
Python service ships only `NotImplementedBackend`, which makes no network changes
and reports `ENFORCEMENT_NOT_AVAILABLE`. A future Windows-native component must
implement the `EnforcementBackend` contract described in
[`docs/windows-enforcement.md`](../docs/windows-enforcement.md); its sources would
live in this directory.`