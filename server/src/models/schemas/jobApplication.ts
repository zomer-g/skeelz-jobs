export interface IJobApplication {
  _id: string;
  userId: string;
  jobId: string;
  /** The CV used for this application ('' = none). */
  cvFileUrl?: string;
  /** 'profile' | 'job' | '' (see services/applicationCv.ts). */
  cvScope?: string;
  createdAt?: Date;
  updatedAt?: Date;
}

export default IJobApplication;
