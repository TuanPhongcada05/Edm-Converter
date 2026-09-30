PI = 3.1415926


for material in bpy.data.materials:
  material.use_shadeless = True
scene = bpy.context.scene

cam = bpy.data.cameras.new("Camera")
cam.type = "ORTHO"
cam.ortho_scale = 10

cam_ob = bpy.data.objects.new("Camera", cam)
cam_ob.position = (20,20,16.32)
cam_ob.rotation_euler = (2*PI/6, 0, 3*2*PI/8)

scene.objects.link(cam_ob)
scene.camera = cam_ob

scene.render.resolution_x = 800
scene.render.resolution_y = 800