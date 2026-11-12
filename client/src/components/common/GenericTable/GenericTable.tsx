import React from 'react';
import './GenericTable.css';
import { ArrowDownIcon, ArrowLeftIcon, ArrowRightIcon, ArrowUpIcon, SortArrows } from '../../../icons';
import Button from '../Button';
import { i18n } from '../../../i18n/I18n';

export interface Column<T> {
  key: keyof T | string;
  header: string;
  sortable?: boolean;
  render?: (row: T) => React.ReactNode;
  className?: string;
  valueClassName?: string;
  sticky?: 'left' | 'right';
  hideHeaderOnMobile?: boolean;
}

interface GenericTableProps<T> {
  columns: Column<T>[];
  rows: T[];
  onRowClick?: (row: T) => void;
  sortField?: string | null;
  sortOrder?: 'asc' | 'desc' | null;
  handleSortChange?: (field: string | null, sort: 'asc' | 'desc' | null) => void;

  paginationModel?: {
    page: number;
    pageSize: number;
  };
  setPaginationModel?: (model: { page: number; pageSize: number }) => void;
  total?: number;
}

function GenericTable<T extends object>({
  columns,
  rows,
  onRowClick,
  sortField,
  sortOrder,
  handleSortChange,
  paginationModel,
  setPaginationModel,
  total
}: GenericTableProps<T>) {

  const translations = i18n.getTranslations();
  const handleSortClick = (key: string) => {
    if (!handleSortChange) return;

    let newSort: 'asc' | 'desc' = 'asc';
    if (sortField === key) {
      newSort = sortOrder === 'asc' ? 'desc' : 'asc';
    }

    handleSortChange(key, newSort);
  };

  const handlePrevPage = () => {
    if (!paginationModel || !setPaginationModel) return;
    setPaginationModel({ ...paginationModel, page: Math.max(0, paginationModel.page - 1) });
  };

  const handleNextPage = () => {
    if (!paginationModel || !setPaginationModel || total === undefined) return;
    const maxPage = Math.ceil(total / paginationModel.pageSize) - 1;
    setPaginationModel({ ...paginationModel, page: Math.min(maxPage, paginationModel.page + 1) });
  };

  return (
    <div className="table-container" dir="rtl">
      <table className="responsive-table">
        <thead>
          <tr>
            {columns.map((col) => (
              <th
                key={col.key as string}
                onClick={() => col.sortable && handleSortClick(col.key as string)}
                className={`${col.sortable ? 'sortable' : ''} ${col.className || ''} ${col.sticky ? `sticky-${col.sticky}` : ''}`}
                >
                <span className='px-2 font-RubikMedium'>
                  {col.header}  
                </span>  
                {sortField === col.key && (sortOrder === 'asc' ? <ArrowUpIcon/> : <ArrowDownIcon/>)}
                <span className='px-2'>
                  {!sortOrder && <SortArrows/>}  
                </span>
              </th>
            ))}
          </tr>
        </thead>
          {
            rows.length==0 &&
              <span className='text-dark font-RubikSmall px-5'>{translations.Jobs.NoJobsFound}</span>      
          }
        <tbody>
          {rows.map((row, rowIndex) => (
            <tr className='rowStyle' key={rowIndex} onClick={() => onRowClick?.(row)}>
              {columns.map((col) => (
                <td key={col.key as string}
                data-label={!col.hideHeaderOnMobile ? `${col.header}: ` : undefined}
                className={`${col.className || ''} ${col.sticky ? `sticky-${col.sticky}` : ''}`}
                >
                  <div className={col.valueClassName || ''}>
                    {col.render ? col.render(row) : String(row[col.key as keyof T] ?? '')}
                  </div>
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>

      {paginationModel && setPaginationModel && total !== undefined && (
        <div className="pagination-container">
          <Button onClick={handlePrevPage} disabled={paginationModel.page === 0}>
          <span className='px-2'>
            <ArrowRightIcon/>
          </span>
          <span className='text-dark font-RubikSmall ps-1 ps-md-4' >{translations.Table.Previous}</span>
          </Button>
          <span className='fs-16'>
          {translations.Table.Page} {paginationModel.page + 1} {translations.Table.Of} {Math.ceil(total / paginationModel.pageSize)}
          </span>
          <Button
            onClick={handleNextPage}
            disabled={(paginationModel.page + 1) * paginationModel.pageSize >= total}
          >
            <span className='text-dark font-RubikSmall pe-4' >{translations.Table.Next}</span>
          <span className='px-2 px-md-3'>
          <ArrowLeftIcon/>
            </span>  
          </Button>
        </div>
      )}
    </div>
  );
}

export default GenericTable;
