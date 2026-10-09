"use client";
import Link from "next/link";
import { Suspense, useEffect, useMemo, useState } from "react";
import { useAuth } from "@/lib/auth";
import { useOrganizations } from "@/lib/queries";
import type { Organization } from "@/lib/types";
import {
  Alert,
  Button,
  Empty,
  ErrorBox,
  PageHeader,
  Pagination,
  SortTh,
  Spinner,
  StatusBadge,
} from "@/components/ui";
import {
  DeleteOrgDialog,
  LoginLinkButton,
  OrgFormDialog,
  OrgPasswordDialog,
  OrgStatusDialog,
  AccessTokenControls,
} from "@/components/OrgDialogs";

const PAGE_SIZE = 20;
type SortKey = "code" | "name" | "status";
const collator = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: "base",
}); // INS-2 before INS-10

function OrganizationsInner() {
  const { isSuper, user, features } = useAuth();
  const orgs = useOrganizations();
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<Organization | null>(null);
  const [toggling, setToggling] = useState<Organization | null>(null);
  const [passwordOrg, setPasswordOrg] = useState<Organization | null>(null);
  const [deleting, setDeleting] = useState<Organization | null>(null);
  // Only when the server allows it (ALLOW_ORGANIZATION_DELETE; on by default outside production).
  const canDelete = features?.organization_delete === true;
  const [sort, setSort] = useState<{ key: SortKey; dir: "asc" | "desc" }>({
    key: "code",
    dir: "asc",
  });
  const [page, setPage] = useState(1);
  const onSort = (key: SortKey) => {
    setSort((s) =>
      s.key === key
        ? { key, dir: s.dir === "asc" ? "desc" : "asc" }
        : { key, dir: "asc" },
    );
    setPage(1);
  };
  // Every organization is loaded (the organization picker needs them all), so sort and page here:
  // sorting covers all organizations, not just the visible page.
  const sorted = useMemo(() => {
    const items = [...(orgs.data?.items ?? [])];
    const val = (o: Organization) =>
      sort.key === "status" ? o.status : o[sort.key];
    items.sort(
      (a, b) =>
        collator.compare(val(a), val(b)) || collator.compare(a.code, b.code),
    );
    return sort.dir === "asc" ? items : items.reverse();
  }, [orgs.data, sort]);
  const pages = Math.max(1, Math.ceil(sorted.length / PAGE_SIZE));
  useEffect(() => {
    if (page > pages) setPage(pages); // e.g. after deleting the last organization of the last page
  }, [page, pages]);
  const visible = sorted.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  if (!isSuper) {
    return (
      <Alert tone="info">
        Organization administrators manage only their own organization.{" "}
        <Link href={`/organizations/${user?.organization_id}`}>Open it</Link>.
      </Alert>
    );
  }

  return (
    <>
      <PageHeader
        title="Organizations"
        subtitle="Tenants: every computer, restriction and group belongs to exactly one."
        actions={
          <Button variant="primary" onClick={() => setCreating(true)}>
            New organization
          </Button>
        }
      />
      {orgs.error && <ErrorBox error={orgs.error} />}
      {orgs.isLoading ? (
        <Spinner />
      ) : !orgs.data?.items.length ? (
        <Empty>
          No organizations yet. Create one, then generate its access token for
          the service installer.
        </Empty>
      ) : (
        <>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <SortTh label="Code" k="code" sort={sort} onSort={onSort} />
                  <SortTh label="Name" k="name" sort={sort} onSort={onSort} />
                  <SortTh
                    label="Status"
                    k="status"
                    sort={sort}
                    onSort={onSort}
                  />
                  <th>Access token</th>
                  <th>
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {visible.map((o) => (
                  <tr key={o.id}>
                    <td>
                      <Link href={`/organizations/${o.id}`} className="strong">
                        {o.code}
                      </Link>
                    </td>
                    <td>{o.name}</td>
                    <td>
                      <StatusBadge status={o.status} />
                    </td>
                    <td>
                      <div className="cell-inline">
                        <AccessTokenControls org={o} short />
                      </div>
                    </td>
                    <td className="cell-actions">
                      <div className="btn-row">
                        <LoginLinkButton org={o} />
                        <Button size="sm" onClick={() => setEditing(o)}>
                          Edit
                        </Button>
                        <Button size="sm" onClick={() => setPasswordOrg(o)}>
                          Update password
                        </Button>
                        <Button
                          size="sm"
                          variant={
                            o.status === "ACTIVE" ? "danger" : "secondary"
                          }
                          onClick={() => setToggling(o)}
                        >
                          {o.status === "ACTIVE" ? "Disable" : "Enable"}
                        </Button>
                        {canDelete && (
                          // Only a disabled organization can be deleted (its admins and services are locked out first).
                          <span
                            title={
                              o.status === "ACTIVE"
                                ? "Disable the organization first, then it can be deleted"
                                : `Delete ${o.code} and its administrators`
                            }
                          >
                            <Button
                              size="sm"
                              variant="danger"
                              disabled={o.status === "ACTIVE"}
                              onClick={() => setDeleting(o)}
                            >
                              Delete
                            </Button>
                          </span>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="table-footer">
            <span className="muted small">
              {sorted.length} organization{sorted.length === 1 ? "" : "s"}
            </span>
            {sorted.length > PAGE_SIZE && (
              <Pagination
                page={page}
                pageSize={PAGE_SIZE}
                total={sorted.length}
                onPage={setPage}
              />
            )}
          </div>
        </>
      )}
      <OrgFormDialog open={creating} onClose={() => setCreating(false)} />
      <OrgFormDialog
        open={!!editing}
        org={editing}
        onClose={() => setEditing(null)}
      />
      <OrgStatusDialog org={toggling} onClose={() => setToggling(null)} />
      <OrgPasswordDialog
        org={passwordOrg}
        onClose={() => setPasswordOrg(null)}
      />
      {canDelete && (
        <DeleteOrgDialog org={deleting} onClose={() => setDeleting(null)} />
      )}
    </>
  );
}

export default function OrganizationsPage() {
  return (
    <Suspense fallback={<Spinner />}>
      <OrganizationsInner />
    </Suspense>
  );
}
