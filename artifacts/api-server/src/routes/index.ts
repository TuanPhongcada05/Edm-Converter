import { Router, type IRouter } from "express";
import healthRouter from "./health";
import edmRouter from "./edm";

const router: IRouter = Router();

router.use(healthRouter);
router.use(edmRouter);

export default router;
