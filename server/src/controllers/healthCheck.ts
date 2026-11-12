import { Request, Response } from 'express';

export class HealthCheck {

  constructor() {

  }

  async getHealthCheck(req: Request, res: Response): Promise<void> {
    try {
      res.status(200).json({data: "Healthy"});
    } catch (error) {
      res.status(500).json({ message: 'Internal server error' });
    }
  }
}
