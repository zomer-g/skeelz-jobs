import { GridPaginationModel } from '@mui/x-data-grid';
import {keyValue, userProfile } from '../../models/interfaces/Props.interfaces';
import MarketingStatus from './MarketingStatus';
import { RoleBlocksButton, useIsAdmin } from './RoleBlocks';
import { i18n } from '../../i18n/I18n';
import { formatDate, getDefaultFilenameByMime, isString } from '../../utils/utils';
import { UploadFileService } from '../../services/api/UploadFile.service';
import useToastStore from '../../store/Toast.store';
import { TablePagination, useMediaQuery } from '@mui/material';
import RtlProvider from '@mui/system/RtlProvider';
import React, { useEffect, useRef, useState } from 'react';
import useModalStore from '../../store/Modal.store';
import ListDisplay from '../common/ListDisplay';
import {ArchiveIcon, EyeIcon, SortArrows, TrashIcon, WarningIcon} from '../../icons';
import Button from '../common/Button';
import { UploadFileModal } from '../common/UploadFileModal';
import { ROLE_LABELS } from '../../i18n/General.enums';

interface UserTableProps {
    users: userProfile[];
    handleSortChange: (field: string | null, sort: 'asc' | 'desc' | null) => void;
    /** The sort in force (UsersManagement keeps it; the server sorts). */
    sortConfig: { field: string | null; sort: SortDirection };
    paginationModel: GridPaginationModel; // The current pagination model (page and pageSize)
    setPaginationModel: React.Dispatch<React.SetStateAction<GridPaginationModel>>; // Function to update pagination model
    totalUsers: number;
    deleteFile: (cvFileUrl: string, userId: string) => Promise<void>;
    downloadFile: (userId: string) => Promise<void>;
    uploadFile: (userId: string, cvFilePath:string) => Promise<string | void>;
    previewFile: (userId: string) => Promise<void>;
    /** A placement coordinator sees candidates but changes nothing (no CV unlink). */
    readOnly?: boolean;
    /** Reload the list (after a marketing removal). */
    onChanged?: () => void;
}

const translations = i18n.getTranslations();

type SortDirection = 'asc' | 'desc' | null;
// The columns the server sorts candidates by (SORT_COLUMNS in server/src/dal/userDAL.ts); others have no sort button.
const SORTABLE: { field: string; label: string }[] = [
    { field: 'firstName', label: translations.UserProfile.FirstName },
    { field: 'lastName', label: translations.UserProfile.LastName },
    { field: 'location', label: translations.UserProfile.Location },
    { field: 'dateOfBirth', label: translations.UserProfile.DateOfBirth },
    { field: 'email', label: translations.UserProfile.Email },
    { field: 'phoneNumber', label: translations.UserProfile.PhoneNumber },
];

const UserTable: React.FC<UserTableProps> = ({
    users,
    handleSortChange,
    sortConfig,
    paginationModel, // The current pagination model (page and pageSize)
    setPaginationModel,
     totalUsers,
     deleteFile,
     downloadFile,
     uploadFile,
     previewFile,
     readOnly = false,
     onChanged = () => undefined,
}) => {

    const { initModal } = useModalStore();
    const isAdmin = useIsAdmin(); // only admins block roles (24.11.2026)
    const [cvFilePath, setCvFilePath] = useState('');
    
    const [currUsers, setCurrUsers] = useState<userProfile[]>(users);
    
    useEffect(()=>{
        setCurrUsers(users)
    },[users])


    function handleCvFilePath(value: string): void {
        setCvFilePath(value)
    }

    const handleUpdateUser = (index: number, userId: string, cvFilePath: string) => {
        setCurrUsers(prev => {
          const updated = [...prev];
          updated[index] = {
            ...updated[index],
            cvFileUrl: cvFilePath,
          };
          return updated;
        });
      };

    
    // The CV sent with one application (a CV for that job only is not on the profile): the server's CV hand-over
    // (daily limit, strict log before the file leaves, alerts).
    async function downloadApplicationCv(userId: string, jobId: string) {
        const result = await UploadFileService.getInstance().fetchApplicationCv(userId, jobId);
        if (isString(result)) { useToastStore.getState().showToast(result, 'error'); return; }
        const contentType = String(result.headers['content-type'] || 'application/octet-stream');
        const blob = new Blob([result.data], { type: contentType });
        const disposition = result.headers['content-disposition'] ? String(result.headers['content-disposition']) : undefined;
        const star = disposition?.match(/filename\*=UTF-8''([^;]+)/);
        const plain = disposition?.match(/filename="?([^";]+)"?/);
        const filename = (star ? decodeURIComponent(star[1]) : plain?.[1]) || getDefaultFilenameByMime(contentType);
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        a.click();
        window.URL.revokeObjectURL(url);
        useToastStore.getState().showToast(translations.Cv.DownloadedFile, 'success');
    }

    function openJobApplicationsModal(row: { _id?: string; jobApplicationsToDisplay?: unknown; applicationCvJobs?: string[] }) {
        const jobApplications = row.jobApplicationsToDisplay as keyValue[];
        const entries: [string, string][] = jobApplications && !Array.isArray(jobApplications) && typeof jobApplications === 'object'
            ? Object.entries(jobApplications as unknown as Record<string, string>) : [];
        const withCv = new Set((row.applicationCvJobs ?? []).map(String));
        initModal({
            active: true,
            modalTitle: translations.UserProfile.JobApplications,
            modalBody: 
                <div className='overflow-auto  custom-scrollbar min-h-40vh max-h-60vh pb-5 text-center'>
                    <div className='px-2'>
                        {entries.length && withCv.size && row._id ? (
                            <ul className="list-group">
                                {entries.map(([jobId, title]) => (
                                    <li key={jobId} className="list-group-item font-RubikRegular d-flex justify-content-between align-items-center gap-2 flex-wrap">
                                        <span>{title}</span>
                                        {withCv.has(jobId) && (
                                            <button type="button" className="btn btn-link p-0 text-color-purple"
                                                aria-label={`${translations.UserProfile.ApplicationCv}: ${title}`}
                                                onClick={() => downloadApplicationCv(String(row._id), jobId)}>
                                                {translations.UserProfile.ApplicationCv}
                                            </button>
                                        )}
                                    </li>
                                ))}
                            </ul>
                        ) : <ListDisplay items={jobApplications}/>}
                    </div>
                </div>
                
            ,
            modalStyle: {
                titleTypography: {
                    titleClass: 'bg-color-light-green text-color-black fs-6 justify-content-center fs-3 p-2 font-EzerThinLoft',
                    divTitleClass: 'bg-color-light-green text-color-black fs-6 justify-content-center fs-6 p-2 border-bottom border-dark border-bottom-thick',
                }     
            }
        });
    }
    // Answers to the questions content managers added to the sign-up form (settings screen). Shown here only (the
    // list already went through the hand-over: daily limit + log); never to employers.
    type Extra = { id: string; label: string; value: string; active: boolean };
    function openExtraDetailsModal(name: string, extra: Extra[]) {
        initModal({
            active: true,
            modalTitle: `פרטים נוספים: ${name}`,
            modalBody:
            <dl dir="rtl" className='min-h-20vh max-h-60vh overflow-auto p-4 m-0' data-testid="extra-details">
                {extra.map((x) => (
                    <div key={x.id} className="mb-3">
                        <dt className="font-RubikBold">{x.label}{!x.active && <span className="text-color-dark-grey font-RubikRegular"> (שדה כבוי)</span>}</dt>
                        <dd className="font-RubikRegular m-0" style={{ whiteSpace: 'pre-line' }}>{x.value}</dd>
                    </div>
                ))}
            </dl>,
        });
    }

    function openUserSkillsModal(requiredSkillsDetails : keyValue[]) {
        initModal({
            active: true,
            modalTitle: translations.UserProfile.Skills,
            modalBody: 
            <div className=' min-h-40vh max-h-60vh pb-5 text-center'>
                <ListDisplay items={requiredSkillsDetails}  />
            </div>
                
            ,
            modalStyle: {
                titleTypography: {
                    titleClass: 'bg-color-light-green text-color-black fs-6 justify-content-center fs-3 p-2 font-EzerThinLoft',
                    divTitleClass: 'bg-color-light-green text-color-black fs-6 justify-content-center fs-6 p-2 border-bottom border-dark border-bottom-thick',
                }
            }
        });
    }
  
    
    function viewCvModal(userId: string) {
        initModal({
            active: true,
            modalBody: (
                <div className='d-flex justify-content-center flex-column align-items-center text-center'>
                    <div className="my-2 d-flex justify-content-center align-items-center rounded-circle size-3-375rem background-color-green-mint border-color-green-sage border-width-0-5-rem border">
                        <WarningIcon />
                    </div>
                    <h1 className='font-RubikBold py-3 m-0 fs-5'>קורות חיים</h1>
                    <p className='font-RubikRegular text-color-dark-grey text- mb-4'>באיזה דרך תרצה לצפות בקורות החיים של המשתמש</p>
                    <div className='d-flex gap-2'>
                        <Button
                            className='font-RubikMedium my-2 bg-color-dark-green-2 width-9rem h-3rem mb-4'
                            onClick={async () => {
                                previewFile(userId)
                                initModal({ active: false })}
                            }
                        >
                            צפייה
                        </Button>
                        <Button
                            className='font-RubikMedium my-2 text-color-dark-green border-color-dark-green-2-2px width-9rem h-3rem mb-4'
                            onClick={async () => {
                                downloadFile(userId)
                                initModal({ active: false })}
                            }
                        >
                            הורדה
                        </Button>
                    </div>
                </div>
            ),
            modalStyle: {
                bodyClass: "height-16-375rem d-flex flex-column justify-content-center align-items-center",
                dialogClassName: "max-width-25rem"
            }
        });
        }


    function deleteCvModal(cvFileUrl: string, userId: string, index: number) {
        initModal({
            active: true,
            modalBody: (
                <div className='d-flex justify-content-center flex-column align-items-center text-center'>
                    <div className="my-2 d-flex justify-content-center align-items-center rounded-circle size-3-375rem background-color-green-mint border-color-green-sage border-width-0-5-rem border">
                        <WarningIcon />
                    </div>
                    <h1 className='font-RubikBold py-3 m-0 fs-5'>{translations.Cv.DeleteCvTitle}</h1>
                    <p className='font-RubikRegular text-color-dark-grey text- mb-4'>{translations.Cv.DeleteCvWarning}</p>
                    <div className='d-flex gap-2'>
                        <Button
                            className='font-RubikMedium my-2 bg-color-dark-green-2 width-9rem h-3rem mb-4'
                            onClick={async () => {
                                await deleteFile(cvFileUrl, userId);
                                let newCurrUsers = currUsers;
                                newCurrUsers[index].cvFileUrl = '';
                                setCurrUsers(newCurrUsers)
                                initModal({ active: false })}
                            }
                        >
                            {translations.General.Confirm}
                        </Button>
                        <Button
                            className='font-RubikMedium my-2 text-color-dark-green border-color-dark-green-2-2px width-9rem h-3rem mb-4'
                            onClick={() => initModal({ active: false })}
                        >
                            {translations.General.Cancel}
                        </Button>
                    </div>
                </div>
            ),
            modalStyle: {
                bodyClass: "height-16-375rem d-flex flex-column justify-content-center align-items-center",
                dialogClassName: "max-width-25rem"
            }
        });
        }

        const UploadCvModal = (userId: string, index: number) => {
            initModal({
              active: true,
              modalTitle: translations.Cv.UploadCv,
              modalBody: (
                <UploadFileModal
                  userId={userId}
                  index={index}
                  uploadFile={uploadFile}
                  onUpdateUser={handleUpdateUser}
                />
              ),
              modalStyle: {
                bodyClass: "height-35rem justify-content-center",
                dialogClassName: "modal-fullscreen-sm-down max-width-45rem",
                titleClass: "font-RubikBold fs-1-25rem",
              },
              
            });
          };

    // One click: this column ascending → descending → no sort. Another column starts ascending. The new value is
    // computed here and sent as is (the old code sent the previous click's state: always one click behind).
    const handleHeaderClick = (column: string) => {
        const dir: SortDirection = sortConfig.field !== column ? 'asc' : sortConfig.sort === 'asc' ? 'desc' : sortConfig.sort === 'desc' ? null : 'asc';
        handleSortChange(dir ? column : null, dir);
    };

    // Header: the label, and a sort button only on the columns the server sorts by (SORTABLE).
    const sortHeader = (column: string, label: string) => {
        if (!SORTABLE.some((c) => c.field === column)) return <span>{label}</span>;
        const dir = sortConfig.field === column ? sortConfig.sort : null;
        const state = dir === 'asc' ? 'סדר עולה' : dir === 'desc' ? 'סדר יורד' : 'לא ממוין';
        return (
            <div className="d-flex align-items-center gap-1">
                <span>{label}</span>
                <button type="button" className="users-sort-btn" onClick={() => handleHeaderClick(column)}
                    aria-label={`מיון לפי ${label} (כרגע: ${state})`} title={`מיון לפי ${label}`}>
                    {dir === 'asc' ? <i className="bi bi-arrow-up" aria-hidden="true"></i>
                        : dir === 'desc' ? <i className="bi bi-arrow-down" aria-hidden="true"></i>
                        : <SortArrows size={20} color="black" />}
                </button>
            </div>
        );
    };

    const rows = currUsers.map((user, index) => ({
        id: index,
        _id: user._id,
        firstName: user.firstName,
        lastName: user.lastName,
        location: user.location?.city,
        citySymbol: user.location?.citySymbol,
        email: user.email,
        dateOfBirth: user.dateOfBirth,
        gender: user.gender,
        jobApplications: user.jobApplications,
        jobApplicationsToDisplay: user.jobApplicationsToDisplay,
        // Applications sent with a CV (job ids), opened one by one through the CV hand-over.
        applicationCvJobs: ((user as any).applicationCvJobs ?? []) as string[],
        phoneNumber: user.phoneNumber,
        idNumber: (user as any).idNumber ?? '',
        extraDetails: ((user as any).extraDetails ?? []) as Extra[],
        // Marketing mail state from the staff list (GET /api/users): agreed / not_agreed / removed / unknown.
        marketing: (user as any).marketing ?? null,
        skills: user.skills,
        requiredSkillsDetails: user.requiredSkillsDetails,
        role: user.role,
        cvFileUrl: user.cvFileUrl,
    }));


    async function handlePaginationChange(page: number, pageSize: number) {
        try {
            setPaginationModel({ page, pageSize })
        } catch (error) {
            // Handle any errors
            console.error('Error fetching users list:', error);
        }
    }
    
    // Phones: one card per candidate (same rows, same fields, same actions as the table; the same page of the list).
    const isPhone = useMediaQuery('(max-width: 767.98px)', { noSsr: true });
    // RtlProvider: MUI picks the arrows by direction (default ltr), so in this RTL page "next" pointed right. With it,
    // next is the left arrow (<) on the left and previous the right arrow (>) beside the count (owner, 23.11.2026).
    const pager = (
        <RtlProvider value>
        <TablePagination
            component="div"
            className="users-pager"
            count={totalUsers}
            page={paginationModel.page}
            rowsPerPage={paginationModel.pageSize}
            rowsPerPageOptions={[]}
            onPageChange={(_e, page) => handlePaginationChange(page, paginationModel.pageSize)}
            labelDisplayedRows={({ from, to, count }) => `${from}-${to} מתוך ${count !== -1 ? count : `יותר מ ${to}`}`}
            getItemAriaLabel={(type) => (type === 'next' ? 'לעמוד הבא' : type === 'previous' ? 'לעמוד הקודם' : type === 'first' ? 'לעמוד הראשון' : 'לעמוד האחרון')}
        />
        </RtlProvider>
    );
    if (isPhone) {
        const P = translations.UserProfile;
        const field = (label: string, value: React.ReactNode, ltr = false, wide = false) => (
            <div className={`users-card__field${wide ? ' users-card__field--wide' : ''}`}>
                <dt>{label}</dt>
                <dd dir={ltr ? 'ltr' : undefined}>{value || '—'}</dd>
            </div>
        );
        return (
            <div dir='rtl' className="users-cards">
                {/* Sort on a phone: the same server sort as the table's header buttons. */}
                <div className="users-cards__sort">
                    <label>
                        <span>מיון לפי</span>
                        <select className="form-select" value={sortConfig.field ?? ''}
                            onChange={(e) => handleSortChange(e.target.value || null, e.target.value ? (sortConfig.sort ?? 'asc') : null)}>
                            <option value="">ללא מיון</option>
                            {SORTABLE.map((c) => <option key={c.field} value={c.field}>{c.label}</option>)}
                        </select>
                    </label>
                    <label>
                        <span>סדר</span>
                        <select className="form-select" value={sortConfig.sort ?? 'asc'} disabled={!sortConfig.field}
                            onChange={(e) => handleSortChange(sortConfig.field, e.target.value as SortDirection)}>
                            <option value="asc">עולה</option>
                            <option value="desc">יורד</option>
                        </select>
                    </label>
                </div>
                {rows.length === 0 && <p className="users-cards__empty">אין נתונים להצגה</p>}
                <ul className="users-cards__list">
                    {rows.map((row) => {
                        const hasSkills = !!(row.skills && row.skills.length > 0);
                        const hasApplications = !!(row.jobApplicationsToDisplay && Object.keys(row.jobApplicationsToDisplay).length > 0);
                        return (
                            <li key={row._id} className="users-card">
                                <h2 className="users-card__name">{[row.firstName, row.lastName].filter(Boolean).join(' ')}</h2>
                                <dl className="users-card__fields">
                                    {field(P.Location, row.location)}
                                    {field(P.DateOfBirth, row.dateOfBirth ? formatDate(row.dateOfBirth as any) : '')}
                                    {field(P.Gender, translations.UserProfile[row.gender as keyof typeof translations.UserProfile])}
                                    {field(P.Role, ROLE_LABELS[row.role as string] ?? row.role)}
                                    {field(P.Email, row.email, true, true)}
                                    <div className="users-card__field"><dt>דיוור שיווקי</dt><dd><MarketingStatus id={row._id} name={[row.firstName, row.lastName].filter(Boolean).join(' ')} value={(row as any).marketing} readOnly={readOnly} onChanged={onChanged} /></dd></div>
                                    {isAdmin && <div className="users-card__field"><dt>חסימת תפקידים</dt><dd><RoleBlocksButton id={row._id} who={[row.firstName, row.lastName].filter(Boolean).join(' ')} blocked={(row as any).blockedRoles} onChanged={onChanged} /></dd></div>}
                                    {field(P.PhoneNumber, row.phoneNumber, true)}
                                    {field(translations.Register.IdNumber, row.idNumber, true)}
                                </dl>
                                {(hasSkills || hasApplications || row.cvFileUrl || row.extraDetails.length > 0) && (
                                    <div className="users-card__actions">
                                        {row.extraDetails.length > 0 && (
                                            <button type="button" className="users-card__action" onClick={() => openExtraDetailsModal([row.firstName, row.lastName].filter(Boolean).join(' '), row.extraDetails)}>
                                                <i className="bi bi-list-ul" aria-hidden="true"></i> פרטים נוספים
                                            </button>
                                        )}
                                        {hasSkills && (
                                            <button type="button" className="users-card__action" onClick={() => openUserSkillsModal(row.requiredSkillsDetails as keyValue[])}>
                                                <i className="bi bi-person-vcard" aria-hidden="true"></i> {P.Skills}
                                            </button>
                                        )}
                                        {hasApplications && (
                                            <button type="button" className="users-card__action" onClick={() => openJobApplicationsModal(row)}>
                                                <ArchiveIcon /> {P.JobApplications}
                                            </button>
                                        )}
                                        {row.cvFileUrl && (
                                            <button type="button" className="users-card__action" onClick={() => previewFile(row._id as string)}>
                                                <EyeIcon /> {P.Cv}
                                            </button>
                                        )}
                                        {row.cvFileUrl && !readOnly && (
                                            <button type="button" className="users-card__action users-card__action--danger" aria-label={`${translations.Cv.DeleteCvTitle}: ${row.firstName ?? ''} ${row.lastName ?? ''}`}
                                                onClick={() => deleteCvModal(row.cvFileUrl as string, row._id as string, row.id)}>
                                                <TrashIcon />
                                            </button>
                                        )}
                                    </div>
                                )}
                            </li>
                        );
                    })}
                </ul>
                {pager}
            </div>
        );
    }

    // Wider screens: ONE html table, so the header row and the rows can never come apart (the MUI DataGrid drew them
    // as two grids kept in step by its own measuring and scrolling, which broke in production). When the table is wider
    // than the screen it scrolls sideways in its own box, and the name ("שם" = first + last) stays in view (sticky).
    const P = translations.UserProfile;
    const ariaSort = (column: string): React.AriaAttributes['aria-sort'] =>
        sortConfig.field === column ? (sortConfig.sort === 'asc' ? 'ascending' : 'descending') : undefined;
    return (
        <div dir='rtl' className="users-table">
            <div className="users-table__scroll" tabIndex={0} role="region" aria-label={P.Users}>
                <table className="users-table__table">
                    <thead>
                        <tr>
                            <th scope="col" className="users-table__name" aria-sort={ariaSort('firstName')}>{sortHeader('firstName', 'שם')}</th>
                            <th scope="col" aria-sort={ariaSort('location')}>{sortHeader('location', P.Location)}</th>
                            <th scope="col" aria-sort={ariaSort('dateOfBirth')}>{sortHeader('dateOfBirth', P.DateOfBirth)}</th>
                            <th scope="col">{P.Gender}</th>
                            <th scope="col" className="users-table__icon">{P.Skills}</th>
                            <th scope="col" aria-sort={ariaSort('email')}>{sortHeader('email', P.Email)}</th>
                            <th scope="col" aria-sort={ariaSort('phoneNumber')}>{sortHeader('phoneNumber', P.PhoneNumber)}</th>
                            <th scope="col">{translations.Register.IdNumber}</th>
                            <th scope="col">דיוור שיווקי</th>
                            <th scope="col" className="users-table__icon">פרטים נוספים</th>
                            <th scope="col" className="users-table__icon">{P.JobApplications}</th>
                            <th scope="col" className="users-table__icon">{P.Cv}</th>
                            <th scope="col">{P.Role}</th>
                        </tr>
                    </thead>
                    <tbody>
                        {rows.length === 0 && (
                            <tr><td colSpan={12} className="users-table__empty">אין נתונים להצגה</td></tr>
                        )}
                        {rows.map((row) => {
                            const name = [row.firstName, row.lastName].filter(Boolean).join(' ');
                            const hasSkills = !!(row.skills && row.skills.length > 0);
                            const hasApplications = !!(row.jobApplicationsToDisplay && Object.keys(row.jobApplicationsToDisplay).length > 0);
                            return (
                                <tr key={row._id}>
                                    <th scope="row" className="users-table__name">{name}</th>
                                    <td title={row.location ?? ''}><span className="users-table__clip users-table__city">{row.location}</span></td>
                                    <td>{row.dateOfBirth ? formatDate(row.dateOfBirth as any) : ''}</td>
                                    <td>{translations.UserProfile[row.gender as keyof typeof translations.UserProfile]}</td>
                                    <td className="users-table__icon">
                                        {hasSkills && (
                                            <button type="button" className="btn" aria-label={`${P.Skills}: ${name}`}
                                                onClick={() => openUserSkillsModal(row.requiredSkillsDetails as keyValue[])}>
                                                <i className="bi bi-person-vcard" aria-hidden="true"></i>
                                            </button>
                                        )}
                                    </td>
                                    <td title={row.email}><span dir="ltr" className="users-table__clip users-table__email">{row.email}</span></td>
                                    <td><span dir="ltr">{row.phoneNumber}</span></td>
                                    <td><span dir="ltr">{row.idNumber || '—'}</span></td>
                                    <td><MarketingStatus id={row._id} name={name} value={(row as any).marketing} readOnly={readOnly} onChanged={onChanged} />
                                        {isAdmin && <div className="mt-1"><RoleBlocksButton id={row._id} who={name} blocked={(row as any).blockedRoles} onChanged={onChanged} /></div>}</td>
                                    <td className="users-table__icon">
                                        {row.extraDetails.length > 0 && (
                                            <button type="button" className="btn" aria-label={`פרטים נוספים: ${name}`}
                                                onClick={() => openExtraDetailsModal(name, row.extraDetails)}>
                                                <i className="bi bi-list-ul" aria-hidden="true"></i>
                                            </button>
                                        )}
                                    </td>
                                    <td className="users-table__icon">
                                        {hasApplications && (
                                            <button type="button" className="btn" aria-label={`${P.JobApplications}: ${name}`}
                                                onClick={() => openJobApplicationsModal(row)}>
                                                <ArchiveIcon />
                                            </button>
                                        )}
                                    </td>
                                    <td className="users-table__icon">
                                        {row.cvFileUrl ? (
                                            <span className="users-table__cv">
                                                <button type="button" className="btn" aria-label={`${P.Cv}: ${name}`} onClick={() => previewFile(row._id as string)}>
                                                    <EyeIcon />
                                                </button>
                                                {!readOnly && (
                                                    <button type="button" className="btn" aria-label={`${translations.Cv.DeleteCvTitle}: ${name}`}
                                                        onClick={() => deleteCvModal(row.cvFileUrl as string, row._id as string, row.id)}>
                                                        <TrashIcon />
                                                    </button>
                                                )}
                                            </span>
                                        ) : null}
                                    </td>
                                    <td>{ROLE_LABELS[row.role as string] ?? row.role}</td>
                                </tr>
                            );
                        })}
                    </tbody>
                </table>
            </div>
            {pager}
        </div>
    );
};

export default UserTable;



